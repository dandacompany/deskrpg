/**
 * The report call decision — answers only "whom to call now".
 *
 * The call itself uses the existing `npc:call` as is (no new event). What matters here is when **not**
 * to fire — do not interrupt a conversation, and do not call again while they are walking over.
 */
import type { RoomMessage, RoomSummary } from "@/lib/chat-rooms-policy";

import { pendingReports, type ReportAck, type ReportItem } from "@/game/report-queue";

/**
 * Extract this channel's report queue from the room state and roster. It takes the shape the screen holds as is
 * so no decisions remain inside the component — if the office room does not exist yet, the queue is empty.
 */
export function reportsForChannel(input: {
  rooms: readonly RoomSummary[];
  messages: Readonly<Record<string, RoomMessage[]>>;
  npcs: readonly { id: string; active: boolean }[];
  acknowledged: ReportAck;
}): ReportItem[] {
  const officeId = input.rooms.find((room) => room.kind === "office")?.id ?? null;
  if (!officeId) return [];
  return pendingReports(
    input.messages[officeId] ?? [],
    input.acknowledged,
    input.npcs.filter((npc) => npc.active).map((npc) => npc.id),
  );
}

/**
 * Where opening this report goes. Card reports go to kanban, cron failures to the cron history.
 *
 * Fudging this inside the component with `cardId ?? ""` made cron failure reports **impossible to
 * acknowledge by any means**, and the badge stayed forever. The branching point lives here, pinned by tests.
 */
export function reportTarget(
  item: ReportItem,
): { kind: "card"; cardId: string } | { kind: "cron"; jobId: string } | null {
  if (item.jobId) return { kind: "cron", jobId: item.jobId };
  if (item.cardId) return { kind: "card", cardId: item.cardId };
  return null;
}

/**
 * The result of one call. `signature` is **the observable state of that employee at that moment** (see below).
 *
 * - `sent` — fired and not yet refused. An optimistic marker that prevents firing the same report twice.
 * - `rejected` — refused. Not fired again **while** that employee's state stays the same.
 * - `dismissed` — the employee came and the dialog opened, but the user closed it without acknowledging. Not called
 *   again for a while (`reviveDismissedReports` revives it). It stays in the badge and the report list.
 */
export type ReportAttempt = {
  messageId: string;
  outcome: "sent" | "rejected" | "dismissed";
  signature: string;
  /** Whether the employee ever actually became mine through the sent call. Only losing them after that counts as "taken". */
  acquired?: boolean;
  /** Whether we opened the dialog on their behalf because the arrival signal was missed. Opened only once. */
  opened?: boolean;
  /** The time (ms) it became `dismissed`. Decides when to revive. */
  dismissedAt?: number;
};

/** Time until a folded report becomes a candidate again on its own (Dante's decision, 2026-09-21: about 10 minutes). */
export const DISMISSED_REPORT_REVIVE_MS = 10 * 60 * 1000;

/**
 * The employee state that serves as the retry signal. Combines the motion snapshot's `phase` with "am I the owner".
 *
 * Why not time-based retries: if a meeting lasts an hour, calls keep missing the whole time.
 * The moment the state changes is the only basis for "now it might work".
 */
export function npcSignature(
  phase: string | undefined,
  ownerSocketId: string | undefined,
  mySocketId: string | undefined,
  /**
   * Whether they are at their own seat (home). Before and after a meeting the employee **comes back in the same shape** — an
   * employee seated at the meeting and one back at their seat are both `idle` · no owner. Without this, a call refused with
   * stale screen state the moment the meeting ends looks like "nothing changed" even after the return finishes, and is never
   * retried (staging measurement: they did not come to report even after the meeting ended).
   */
  atHome: boolean,
): string {
  const owner = !ownerSocketId ? "none" : ownerSocketId === mySocketId ? "mine" : "other";
  return `${phase ?? "unknown"}:${owner}:${atHome ? "home" : "away"}`;
}

/** Read only the "am I the owner" part of the signature. Kept in the same file as `npcSignature` so the format does not drift. */
function signatureOwner(signature: string): string {
  return signature.split(":")[1] ?? "none";
}

/**
 * Settle the result of sent calls into employee state.
 *
 * "Sent" was released only when the report was acknowledged and left the queue. So if a meeting took the employee coming
 * on my call, that report stayed "sent" forever and was not called again even after the meeting. Now, once the employee
 * has become mine and **stops being mine**, the attempt is treated as refused with that moment's signature —
 * when the state changes again (e.g. they get home) it becomes a candidate.
 *
 * Do not touch it before they become mine. Right after sending a call the snapshot is still the old state and
 * looks like "not mine"; treating that as lost would cancel the call just sent.
 */
export function reconcileReportAttempts(
  attempts: readonly ReportAttempt[],
  signatures: Readonly<Record<string, string>>,
  queue: readonly ReportItem[],
): ReportAttempt[] {
  return attempts.map((attempt) => {
    if (attempt.outcome !== "sent") return attempt;
    const npcId = queue.find((item) => item.messageId === attempt.messageId)?.npcId;
    if (!npcId) return attempt;
    const signature = signatures[npcId];
    if (!signature) return attempt;
    const mine = signatureOwner(signature) === "mine";
    if (mine) return attempt.acquired ? attempt : { ...attempt, acquired: true };
    if (!attempt.acquired) return attempt;
    // If they are already back at their seat the signature will not change further — refusing with that signature would never
    // call them again (staging measurement: after Oliver went back via the server return, one badge remained and nobody
    // came). In that case leave an empty signature so they become a candidate **immediately**. If still heading back,
    // keep that moment's signature so they become a candidate when they reach home and the signature changes.
    const home = signature.endsWith(":home");
    return { messageId: attempt.messageId, outcome: "rejected", signature: home ? "" : signature };
  });
}

/**
 * When the socket drops, turn calls with no response (sent, but the employee never became mine) into refusals.
 * It is unknown whether the server received the call, so leave an empty signature so it becomes a candidate again
 * **immediately** after reconnecting. Reports already mine are left as is, since the employee is here or on the way.
 */
export function releaseUnacquiredReportCalls(
  attempts: readonly ReportAttempt[],
): readonly ReportAttempt[] {
  if (!attempts.some((attempt) => attempt.outcome === "sent" && !attempt.acquired)) return attempts;
  return attempts.map((attempt) =>
    attempt.outcome === "sent" && !attempt.acquired
      ? { messageId: attempt.messageId, outcome: "rejected", signature: "" }
      : attempt,
  );
}

/**
 * Whether the report being delivered is no longer "in progress". Holding a report that turned into a refusal (or fold) as active
 * makes `decideReportCall` wait only on that report and stall **the whole queue** — the screen clears active at that point.
 */
export function activeReportReleased(
  attempts: readonly ReportAttempt[],
  activeMessageId: string | null,
): boolean {
  if (!activeMessageId) return false;
  const attempt = attempts.find((a) => a.messageId === activeMessageId);
  return attempt !== undefined && attempt.outcome !== "sent";
}

/**
 * Tidy the list of returned employees — remove those who reached their seat (signature `:home` and I am not the owner).
 * Right after pressing return the snapshot still says "waiting on my call", so the signature alone cannot tell whether they are returning.
 * So the screen adds them the moment it is pressed, and here arrival is confirmed and they are removed.
 */
export function settleReturningNpcs(
  returning: ReadonlySet<string>,
  signatures: Readonly<Record<string, string>>,
): ReadonlySet<string> {
  let changed = false;
  const next = new Set(returning);
  for (const npcId of returning) {
    const signature = signatures[npcId] ?? "";
    if (signature.endsWith(":home") && signatureOwner(signature) !== "mine") {
      next.delete(npcId);
      changed = true;
    }
  }
  return changed ? next : returning;
}

/**
 * Whether employees must not be called to report right now.
 *
 * Do not interrupt when the dialog, kanban or cron modal is open. Also do not call **while in the meeting
 * room** — automatic report calls bind the employee to my call, and for a bound employee the meeting gathering cannot capture
 * the original position, so the gathering breaks with "참가자를 찾을 수 없습니다". With pending reports a meeting could not
 * be started (staging measurement). Either way the queue stays as is and continues once the blocking reason is gone.
 */
export function reportCallBlocked(input: {
  dialogOpen: boolean;
  kanbanOpen: boolean;
  cronOpen: boolean;
  inMeeting: boolean;
}): boolean {
  return input.dialogOpen || input.kanbanOpen || input.cronOpen || input.inMeeting;
}

export function decideReportCall(input: {
  queue: readonly ReportItem[];
  /** The report currently being brought or delivered. Tracked per report, not per employee. */
  activeMessageId: string | null;
  /** What was done to these reports and how it turned out. */
  attempts: readonly ReportAttempt[];
  /** Each employee's current state signature. If it differs from the time of refusal, they can be called again. */
  signatures: Readonly<Record<string, string>>;
  /** Whether calling is blocked right now (`reportCallBlocked`). The queue stays as is. */
  blocked: boolean;
  /** Employees not to call right now because they are heading back to their seats (`settleReturningNpcs`). */
  returningNpcIds?: ReadonlySet<string>;
}): ReportItem | null {
  if (input.blocked) return null;
  const callable = (item: ReportItem): boolean => {
    // An employee being returned is not a candidate until reaching their seat. The moment a return acknowledged a report, the same
    // employee's folded report revived and was called again right away, and that call reversed the return so the employee stayed
    // beside us (staging measurement: Oliver was returned but stayed "waiting on my call" and Sophie came first).
    if (input.returningNpcIds?.has(item.npcId)) return false;
    if ((input.signatures[item.npcId] ?? "").startsWith("returning:")) return false;
    const attempt = input.attempts.find((a) => a.messageId === item.messageId);
    if (!attempt) return true;
    // While waiting for a result, do not fire again. Reports the user closed are not called again either.
    if (attempt.outcome === "sent" || attempt.outcome === "dismissed") return false;
    // Refused — becomes a candidate again only when that employee's state has changed.
    return (input.signatures[item.npcId] ?? "unknown:none:away") !== attempt.signature;
  };
  // Do not call the next person until the report being delivered finishes — one at a time.
  const active = input.queue.find((item) => item.messageId === input.activeMessageId);
  // A report that ended in refusal or fold does not hold the queue even if active (`activeReportReleased`).
  if (active && !activeReportReleased(input.attempts, active.messageId))
    return callable(active) ? active : null;
  // Otherwise it is **in the order reports arose**. It used to pick the reporting employee's remaining reports first, so in a
  // Sophie→Oliver→Sophie queue Sophie was called again and Oliver never came (the badge was pointing at Oliver's
  // report). The same employee going back and forth twice is accepted. If the head is refused and blocked, move on to the
  // next candidate so the whole queue does not stall (head-of-line blocking).
  return input.queue.find(callable) ?? null;
}

/**
 * A report that arrived but whose dialog did not open. If there is one, the screen opens the dialog on its behalf.
 *
 * The dialog opens only on a single `npc:movement-arrived`. If a meeting cut in while the employee was coming or that
 * signal was missed, the employee stands beside me as `waiting`, the attempt stays "sent", and
 * `decideReportCall`, prioritizing that employee, returned only null so **the whole queue stalled** (staging measurement:
 * Sophie stood "waiting on my call", the badge stayed, and no other employee came either).
 */
export function missedReportArrival(input: {
  queue: readonly ReportItem[];
  activeMessageId: string | null;
  attempts: readonly ReportAttempt[];
  signatures: Readonly<Record<string, string>>;
  blocked: boolean;
}): ReportItem | null {
  if (input.blocked || !input.activeMessageId) return null;
  const item = input.queue.find((entry) => entry.messageId === input.activeMessageId);
  if (!item) return null;
  const attempt = input.attempts.find((a) => a.messageId === item.messageId);
  if (!attempt || attempt.outcome !== "sent" || attempt.opened) return null;
  const signature = input.signatures[item.npcId] ?? "";
  return signature.startsWith("waiting:mine:") ? item : null;
}

/**
 * The dialog with an employee who came to report was closed without acknowledging — do not call this report again this session.
 *
 * Acknowledgment happens when opening the notice link or returning them. Closing only the dialog left the attempt "sent" and
 * stalled the whole queue. Fold **only that one** — the same employee's next report comes again in chronological turn.
 */
export function dismissReport(
  attempts: readonly ReportAttempt[],
  messageId: string,
  now: number,
): ReportAttempt[] {
  return [
    ...attempts.filter((attempt) => attempt.messageId !== messageId),
    { messageId, outcome: "dismissed", signature: "", dismissedAt: now },
  ];
}

/**
 * Return folded reports to candidacy — if **another report was acknowledged** after folding or about 10 minutes passed.
 * Folding permanently leaves a state until the session ends where the badge remains but nobody comes (…75v1A).
 * Returning means deleting the attempt record — a report with no record is a candidate for `decideReportCall`.
 */
export function reviveDismissedReports(
  attempts: readonly ReportAttempt[],
  now: number,
  lastAcknowledgedAt: number | null,
): ReportAttempt[] {
  const next = attempts.filter((attempt) => {
    if (attempt.outcome !== "dismissed") return true;
    const at = attempt.dismissedAt ?? 0;
    if (now - at >= DISMISSED_REPORT_REVIVE_MS) return false;
    return !(lastAcknowledgedAt !== null && lastAcknowledgedAt > at);
  });
  return next.length === attempts.length ? (attempts as ReportAttempt[]) : next;
}

/** "다시 부르기" — immediately return that report to candidacy. */
export function recallReport(
  attempts: readonly ReportAttempt[],
  messageId: string,
): ReportAttempt[] {
  return attempts.filter((attempt) => attempt.messageId !== messageId);
}

/** Reports that should show "folded" and "다시 부르기" in the report list. */
export function dismissedReportIds(attempts: readonly ReportAttempt[]): Set<string> {
  return new Set(attempts.filter((a) => a.outcome === "dismissed").map((a) => a.messageId));
}

/**
 * The browser storage key holding the acknowledgment record (`ReportAck`). A choice made to avoid touching the server read-point schema,
 * at the cost that badges may differ per device. Once read points are sorted out, swap in that value.
 */
export function reportAckKey(channelId: string): string {
  return `deskrpg.reportAck.${channelId}`;
}
