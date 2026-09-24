import assert from "node:assert/strict";
import test from "node:test";

import {
  acknowledgeReport,
  EMPTY_REPORT_ACK,
  pendingReports,
  type ReportItem,
} from "@/game/report-queue";

import type { RoomMessage, RoomSummary } from "@/lib/chat-rooms-policy";

import {
  activeReportReleased,
  decideReportCall,
  dismissReport,
  dismissedReportIds,
  DISMISSED_REPORT_REVIVE_MS,
  recallReport,
  reviveDismissedReports,
  settleReturningNpcs,
  missedReportArrival,
  reportAckKey,
  npcSignature,
  reconcileReportAttempts,
  releaseUnacquiredReportCalls,
  reportCallBlocked,
  reportsForChannel,
  reportTarget,
  type ReportAttempt,
} from "./npc-report-dispatch";

const item = (messageId: string, npcId: string, createdAt: string): ReportItem => ({
  messageId,
  npcId,
  npcName: "소피",
  kind: "card_review",
  cardId: `c-${messageId}`,
  boardSlug: "b",
  jobId: null,
  cardTitle: messageId,
  summary: "",
  createdAt,
});

const sent = (messageId: string, signature = "idle:none") => ({
  messageId,
  outcome: "sent" as const,
  signature,
});
const rejected = (messageId: string, signature: string) => ({
  messageId,
  outcome: "rejected" as const,
  signature,
});

const A = item("a", "npc-1", "2026-09-21T00:00:01.000Z");
const B = item("b", "npc-2", "2026-09-21T00:00:02.000Z");

test("nobody is called when the queue is empty", () => {
  assert.equal(
    decideReportCall({
      queue: [],
      activeMessageId: null,
      attempts: [],
      signatures: {},
      blocked: false,
    }),
    null,
  );
});

test("calls the NPC of the first report", () => {
  assert.equal(
    decideReportCall({
      queue: [A, B],
      activeMessageId: null,
      attempts: [],
      signatures: {},
      blocked: false,
    })?.messageId,
    "a",
  );
});

test("does not call while the dialog or a modal is open — the queue stays", () => {
  assert.equal(
    decideReportCall({
      queue: [A, B],
      activeMessageId: null,
      attempts: [],
      signatures: {},
      blocked: true,
    }),
    null,
  );
});

test("a report whose call was already fired is not called again — no recall while walking over", () => {
  assert.equal(
    decideReportCall({
      queue: [A, B],
      activeMessageId: "a",
      attempts: [sent("a")],
      signatures: {},
      blocked: false,
    }),
    null,
  );
});

test("when the report being delivered finishes and leaves the queue, the next report is called", () => {
  assert.equal(
    decideReportCall({
      queue: [B],
      activeMessageId: "a",
      attempts: [sent("a")],
      signatures: {},
      blocked: false,
    })?.messageId,
    "b",
  );
});

test("the acknowledgment storage key differs per channel", () => {
  assert.equal(reportAckKey("ch-1"), "deskrpg.reportAck.ch-1");
  assert.notEqual(reportAckKey("ch-1"), reportAckKey("ch-2"));
});

const room = (id: string, kind: "office" | "group"): RoomSummary => ({
  id,
  kind,
  name: id,
  replyPolicy: "mention",
  createdBy: "u",
  lastMessageAt: null,
  members: [],
});

const notice = (id: string, npcId: string): RoomMessage => ({
  id,
  roomId: "office",
  senderKind: "npc",
  senderId: npcId,
  senderName: "소피",
  content: "카드",
  createdAt: "2026-09-21T00:00:01.000Z",
  notice: {
    kind: "card_review",
    cardId: `c-${id}`,
    cardTitle: "계약서",
    boardSlug: "b",
    npcName: "소피",
  },
});

test("an empty queue when the office room does not exist yet — right after connecting, before the list arrives", () => {
  assert.deepEqual(
    reportsForChannel({
      rooms: [room("g", "group")],
      messages: { g: [notice("a", "npc-1")] },
      npcs: [{ id: "npc-1", active: true }],
      acknowledged: EMPTY_REPORT_ACK,
    }),
    [],
  );
});

test("only office room notices count — group room notices are not reports", () => {
  const queue = reportsForChannel({
    rooms: [room("office", "office"), room("g", "group")],
    messages: { office: [notice("a", "npc-1")], g: [notice("b", "npc-1")] },
    npcs: [{ id: "npc-1", active: true }],
    acknowledged: EMPTY_REPORT_ACK,
  });
  assert.deepEqual(
    queue.map((item) => item.messageId),
    ["a"],
  );
});

test("reports from sleeping NPCs are not queued — they cannot walk over", () => {
  assert.deepEqual(
    reportsForChannel({
      rooms: [room("office", "office")],
      messages: { office: [notice("a", "npc-1")] },
      npcs: [{ id: "npc-1", active: false }],
      acknowledged: EMPTY_REPORT_ACK,
    }),
    [],
  );
});

test("a refused report is skipped and the next employee is called — the first one does not block the whole queue", () => {
  // When sophie's call is refused, activeMessageId empties and that entry stays in calledMessageIds.
  // The queue used to stall here, and noah never walked over.
  const next = decideReportCall({
    queue: [A, B],
    activeMessageId: null,
    attempts: [sent("a")],
    signatures: {},
    blocked: false,
  });
  assert.equal(next?.messageId, "b");
  assert.equal(
    decideReportCall({
      queue: [A, B],
      activeMessageId: null,
      attempts: [sent("a"), sent("b")],
      signatures: {},
      blocked: false,
    }),
    null,
    "전부 호출했으면 더 부르지 않는다",
  );
});

test("a report being delivered takes priority and is not recalled", () => {
  assert.equal(
    decideReportCall({
      queue: [A, B],
      activeMessageId: "b",
      attempts: [],
      signatures: {},
      blocked: false,
    })?.messageId,
    "b",
    "보고 중인 쪽을 먼저 돌려준다",
  );
  assert.equal(
    decideReportCall({
      queue: [A, B],
      activeMessageId: "a",
      attempts: [sent("a")],
      signatures: {},
      blocked: false,
    }),
    null,
    "보고 중인 직원을 이미 불렀으면 다시 부르지 않는다 — 걸어오는 중이다",
  );
});

test("where to open a report depends on its kind — a cron failure is not a card", () => {
  assert.deepEqual(reportTarget(A), { kind: "card", cardId: "c-a" });
  assert.deepEqual(
    reportTarget({ ...A, kind: "cron_failed", cardId: null, boardSlug: null, jobId: "job-7" }),
    { kind: "cron", jobId: "job-7" },
  );
  assert.equal(
    reportTarget({ ...A, cardId: null, jobId: null }),
    null,
    "열 곳이 없으면 null — 빈 id 로 엉뚱한 모달을 열지 않는다",
  );
});

test("a refused report is not called again while that employee's state stays the same", () => {
  assert.equal(
    decideReportCall({
      queue: [A],
      activeMessageId: null,
      attempts: [rejected("a", "idle:sock-1")],
      signatures: { "npc-1": "idle:sock-1" },
      blocked: false,
    }),
    null,
    "상태가 같으면 결과도 같다 — 매 렌더마다 호출이 나가면 안 된다",
  );
});

test("a refused report becomes a candidate again when that employee's state changes", () => {
  // The measured scenario: the winning tab leaves and ownership passes to this tab (`idle:sock-1` → `idle:mine`).
  // This used to never call again, so the employee walked over only after a reload.
  assert.equal(
    decideReportCall({
      queue: [A],
      activeMessageId: null,
      attempts: [rejected("a", "idle:sock-1")],
      signatures: { "npc-1": "idle:mine" },
      blocked: false,
    })?.messageId,
    "a",
  );
});

test("even when all unacknowledged reports belong to the same employee, they revive when the state changes", () => {
  // A case queue advancement alone could not rescue — in measurement two of Sophie's reports were stuck together.
  const same = { ...B, npcId: "npc-1" };
  assert.equal(
    decideReportCall({
      queue: [A, same],
      activeMessageId: null,
      attempts: [rejected("a", "idle:sock-1"), rejected("b", "idle:sock-1")],
      signatures: { "npc-1": "idle:sock-1" },
      blocked: false,
    }),
    null,
  );
  assert.equal(
    decideReportCall({
      queue: [A, same],
      activeMessageId: null,
      attempts: [rejected("a", "idle:sock-1"), rejected("b", "idle:sock-1")],
      signatures: { "npc-1": "idle:mine" },
      blocked: false,
    })?.messageId,
    "a",
    "되살아나면 발생 순서대로 맨 앞부터",
  );
});

test("a report awaiting a response (sent) is not called again even if the state changes", () => {
  assert.equal(
    decideReportCall({
      queue: [A],
      activeMessageId: null,
      attempts: [sent("a", "idle:sock-1")],
      signatures: { "npc-1": "walking:mine" },
      blocked: false,
    }),
    null,
    "낙관적 표시는 같은 보고를 두 번 쏘는 것을 막는 장치다 — 결과가 오기 전에는 유지한다",
  );
});

// ---------------------------------------------------------------------------
// Do not call anyone to report while in the meeting room.
//
// Automatic report calls bind the employee to **my call**. For a bound employee the meeting gathering could not capture
// the original position and the gathering broke with "참가자를 찾을 수 없습니다" — with pending reports a meeting could not
// be started (staging measurement). The queue stays as is and continues after leaving the meeting room.
// ---------------------------------------------------------------------------

test("report calls are blocked while in the meeting room — same slot as dialog, kanban and cron", () => {
  const base = { dialogOpen: false, kanbanOpen: false, cronOpen: false, inMeeting: false };
  assert.equal(reportCallBlocked(base), false);
  assert.equal(reportCallBlocked({ ...base, inMeeting: true }), true, "회의 중에 직원을 부른다");
  assert.equal(reportCallBlocked({ ...base, dialogOpen: true }), true);
  assert.equal(reportCallBlocked({ ...base, kanbanOpen: true }), true);
  assert.equal(reportCallBlocked({ ...base, cronOpen: true }), true);
});

test("reports blocked during a meeting stay in the queue and become candidates again after leaving the meeting room", () => {
  const queue = [item("m1", "n1", "2026-09-21T10:00:00.000Z")];
  const during = decideReportCall({
    queue,
    activeMessageId: null,
    attempts: [],
    signatures: {},
    blocked: reportCallBlocked({
      dialogOpen: false,
      kanbanOpen: false,
      cronOpen: false,
      inMeeting: true,
    }),
  });
  assert.equal(during, null);
  const after = decideReportCall({
    queue,
    activeMessageId: null,
    attempts: [],
    signatures: {},
    blocked: reportCallBlocked({
      dialogOpen: false,
      kanbanOpen: false,
      cronOpen: false,
      inMeeting: false,
    }),
  });
  assert.equal(after?.messageId, "m1", "회의가 끝났는데 보고가 사라졌다");
});

// ---------------------------------------------------------------------------
// Two paths where employees did not come to report even after returning from a meeting.
//
// Retries happen only on "the employee's state differs from when it was refused". But before and after a meeting the employee's
// state **comes back in the same shape** — an employee seated at the meeting and an employee back at their seat
// are both `idle` · no owner. So even after the state went full circle, "it changed" was not visible.
// ---------------------------------------------------------------------------

test("the signature tells whether they are at their own seat — idle at the meeting seat differs from idle at home", () => {
  assert.notEqual(
    npcSignature("idle", undefined, "me", false),
    npcSignature("idle", undefined, "me", true),
    "회의석과 집을 같은 상태로 본다 — 복귀가 끝나도 재시도가 일어나지 않는다",
  );
});

test("path 2 — even a call refused with stale state the moment the meeting ends is called again once they are home", () => {
  const queue = [item("m1", "n1", "2026-09-21T10:00:00.000Z")];
  // Right after leaving the meeting room: the screen still shows "idle seated at the meeting" while the server has already started
  // the return and refused with `meeting_reserved`. The recorded signature is the meeting seat state the screen saw.
  const atMeetingSeat = npcSignature("idle", undefined, "me", false);
  const attempts = [{ messageId: "m1", outcome: "rejected" as const, signature: atMeetingSeat }];
  const home = npcSignature("idle", undefined, "me", true);
  const next = decideReportCall({
    queue,
    activeMessageId: null,
    attempts,
    signatures: { n1: home },
    blocked: false,
  });
  assert.equal(next?.messageId, "m1", "집에 돌아왔는데 다시 부르지 않는다");
});

test("path 1 — if someone takes the employee coming on my call, the sent attempt turns into a refusal so they can be called again", () => {
  const sentAt = npcSignature("idle", undefined, "me", true);
  let attempts: ReportAttempt[] = [{ messageId: "m1", outcome: "sent", signature: sentAt }];

  // Do not touch it before they have become mine (before the snapshot arrives) — the call just sent must not be seen as lost.
  attempts = reconcileReportAttempts(attempts, { n1: sentAt }, queueOf("m1", "n1"));
  assert.equal(attempts[0].outcome, "sent");

  // Walking over on my call.
  const mine = npcSignature("moving-to-player", "me", "me", false);
  attempts = reconcileReportAttempts(attempts, { n1: mine }, queueOf("m1", "n1"));
  assert.equal(attempts[0].outcome, "sent");

  // A meeting took them — no longer mine.
  const taken = npcSignature("moving-to-player", "leader", "me", false);
  attempts = reconcileReportAttempts(attempts, { n1: taken }, queueOf("m1", "n1"));
  assert.equal(attempts[0].outcome, "rejected", "빼앗긴 호출이 영영 '보냄' 으로 남는다");
  assert.equal(attempts[0].signature, taken);

  // When the meeting ends and they are home, they become a candidate again.
  const next = decideReportCall({
    queue: queueOf("m1", "n1"),
    activeMessageId: null,
    attempts,
    signatures: { n1: npcSignature("idle", undefined, "me", true) },
    blocked: false,
  });
  assert.equal(next?.messageId, "m1");
});

function queueOf(messageId: string, npcId: string) {
  return [item(messageId, npcId, "2026-09-21T10:00:00.000Z")];
}

test("closing the dialog without acknowledging lets the reporting employee block the whole queue — releasing the closed report moves on to the next", () => {
  const queue = [
    item("m1", "sophie", "2026-09-21T01:00:00Z"),
    item("m2", "oliver", "2026-09-21T02:00:00Z"),
  ];
  const signatures = { sophie: "waiting:mine:away", oliver: "idle:none:home" };
  const attempts: ReportAttempt[] = [{ ...sent("m1", "idle:none:home"), acquired: true }];
  // Repro: Sophie arrives and waits, the attempt is "sent" — Oliver is not called either.
  assert.equal(
    decideReportCall({ queue, activeMessageId: "m1", attempts, signatures, blocked: false }),
    null,
  );
  const next = decideReportCall({
    queue,
    activeMessageId: null,
    attempts: dismissReport(attempts, "m1", 0),
    signatures,
    blocked: false,
  });
  assert.equal(next?.messageId, "m2");
});

test("only the one closed report is folded — the same employee's next report comes in chronological turn", () => {
  const queue = [
    item("m1", "sophie", "2026-09-21T01:00:00Z"),
    item("m2", "sophie", "2026-09-21T02:00:00Z"),
  ];
  const attempts = dismissReport([sent("m1")], "m1", 0);
  assert.deepEqual(
    attempts.map((a) => [a.messageId, a.outcome]),
    [["m1", "dismissed"]],
  );
  assert.equal(
    decideReportCall({ queue, activeMessageId: null, attempts, signatures: {}, blocked: false })
      ?.messageId,
    "m2",
  );
});

test("an employee who missed the arrival signal and waits beside me gets the dialog opened for them — only once", () => {
  const queue = [item("m1", "sophie", "2026-09-21T01:00:00Z")];
  const signatures = { sophie: "waiting:mine:away" };
  const attempts: ReportAttempt[] = [{ ...sent("m1"), acquired: true }];
  const input = { queue, activeMessageId: "m1", attempts, signatures, blocked: false };
  assert.equal(missedReportArrival(input)?.messageId, "m1");
  assert.equal(missedReportArrival({ ...input, blocked: true }), null);
  assert.equal(
    missedReportArrival({ ...input, attempts: [{ ...attempts[0], opened: true }] }),
    null,
  );
  // If they are still walking over, wait.
  assert.equal(
    missedReportArrival({ ...input, signatures: { sophie: "moving-to-player:mine:away" } }),
    null,
  );
  assert.equal(missedReportArrival({ ...input, activeMessageId: null }), null);
});

// Dante's decision (2026-09-21): queue in chronological order · acknowledge per report · return = acknowledge.

const officeRoom = {
  id: "office",
  kind: "office" as const,
  name: "사무실",
  replyPolicy: "mention" as const,
  createdBy: "u1",
  lastMessageAt: null,
  members: [],
};
const reportMessage = (id: string, npcId: string, createdAt: string): RoomMessage => ({
  id,
  roomId: "office",
  senderKind: "npc",
  senderId: npcId,
  senderName: npcId,
  content: `${id} 결과 요약`,
  createdAt,
  notice: { kind: "card_review", cardId: `c-${id}`, cardTitle: id, boardSlug: "b", npcName: npcId },
});
// Sophie (outline) → Oliver (body) → Sophie (review) — the queue where Oliver could not come on staging.
const interleaved = [
  reportMessage("toc", "sophie", "2026-09-21T01:00:00Z"),
  reportMessage("body", "oliver", "2026-09-21T02:00:00Z"),
  reportMessage("review", "sophie", "2026-09-21T03:00:00Z"),
];
const interleavedQueue = (acknowledged = EMPTY_REPORT_ACK) =>
  reportsForChannel({
    rooms: [officeRoom],
    messages: { office: interleaved },
    npcs: [
      { id: "sophie", active: true },
      { id: "oliver", active: true },
    ],
    acknowledged,
  });

test("interleaved queue — once Sophie's first report is acknowledged, Oliver comes second, not Sophie", () => {
  const queue = interleavedQueue(acknowledgeReport(EMPTY_REPORT_ACK, "toc"));
  const next = decideReportCall({
    queue,
    // Sophie was reporting until just now — still, no cutting in line.
    activeMessageId: "toc",
    attempts: [{ ...sent("toc"), acquired: true }],
    signatures: { sophie: "waiting:mine:away", oliver: "idle:none:home" },
    blocked: false,
  });
  assert.equal(next?.messageId, "body");
  assert.equal(next?.npcId, "oliver");
});

test("acknowledging one report does not acknowledge other employees' reports — acknowledging a later one leaves Oliver's earlier report", () => {
  const queue = interleavedQueue(acknowledgeReport(EMPTY_REPORT_ACK, "review"));
  assert.deepEqual(
    queue.map((entry) => entry.messageId),
    ["toc", "body"],
  );
});

test("return = acknowledge that report — not recalled for the same report, it moves on to the next", () => {
  // The return handler acknowledges the report being delivered with `acknowledgeReport` and clears it.
  const queue = interleavedQueue(acknowledgeReport(EMPTY_REPORT_ACK, "toc"));
  const next = decideReportCall({
    queue,
    activeMessageId: null,
    attempts: [],
    // Sophie, back home with a changed state — this used to be the moment she was called again for the same report.
    signatures: { sophie: "idle:none:home", oliver: "idle:none:home" },
    blocked: false,
  });
  assert.equal(next?.messageId, "body");
  assert.ok(!queue.some((entry) => entry.messageId === "toc"));
});

test("report entries carry the notice body used for the dialog summary", () => {
  assert.equal(interleavedQueue()[0].summary, "toc 결과 요약");
  assert.equal(
    pendingReports(interleaved, EMPTY_REPORT_ACK, ["oliver"])[0].summary,
    "body 결과 요약",
  );
});

// …75v1A — two paths where the queue stalled after a return the server sent (no user action).

test("automatic return — when the report being delivered turns into a refusal, it does not hold the queue and the next report is called", () => {
  const queue = [
    item("m1", "oliver", "2026-09-21T01:00:00Z"),
    item("m2", "sophie", "2026-09-21T02:00:00Z"),
  ];
  // Oliver lost ownership while heading back (away) — the refusal signature is from that moment.
  const attempts = reconcileReportAttempts(
    [{ ...sent("m1"), acquired: true }],
    { oliver: "returning:none:away", sophie: "idle:none:home" },
    queue,
  );
  assert.equal(attempts[0].outcome, "rejected");
  assert.equal(activeReportReleased(attempts, "m1"), true);
  assert.equal(
    decideReportCall({
      queue,
      activeMessageId: "m1",
      attempts,
      signatures: { oliver: "returning:none:away", sophie: "idle:none:home" },
      blocked: false,
    })?.messageId,
    "m2",
  );
});

test("automatic return — if already home the moment ownership is lost, they become a candidate immediately even without a further signature change", () => {
  const queue = [item("m1", "oliver", "2026-09-21T01:00:00Z")];
  const signatures = { oliver: "idle:none:home" };
  const attempts = reconcileReportAttempts([{ ...sent("m1"), acquired: true }], signatures, queue);
  assert.equal(attempts[0].outcome, "rejected");
  assert.equal(
    decideReportCall({ queue, activeMessageId: "m1", attempts, signatures, blocked: false })
      ?.messageId,
    "m1",
  );
});

test("automatic return — a report refused while heading back is called again once they reach home and the signature changes", () => {
  const queue = [item("m1", "oliver", "2026-09-21T01:00:00Z")];
  const attempts = reconcileReportAttempts(
    [{ ...sent("m1"), acquired: true }],
    { oliver: "returning:none:away" },
    queue,
  );
  const decide = (signature: string) =>
    decideReportCall({
      queue,
      activeMessageId: null,
      attempts,
      signatures: { oliver: signature },
      blocked: false,
    });
  assert.equal(decide("returning:none:away"), null, "아직 돌아가는 중이면 기다린다");
  assert.equal(decide("idle:none:home")?.messageId, "m1");
});

// …75v1A ③ — automatic re-candidacy of folded reports (Dante's decision: another report acknowledged, or about 10 minutes).

test("a folded report becomes a candidate again after about 10 minutes", () => {
  const queue = [item("m1", "oliver", "2026-09-21T01:00:00Z")];
  const attempts = dismissReport([], "m1", 1_000);
  const decide = (a: ReportAttempt[]) =>
    decideReportCall({ queue, activeMessageId: null, attempts: a, signatures: {}, blocked: false });
  assert.equal(decide(reviveDismissedReports(attempts, 1_000 + 60_000, null)), null);
  assert.equal(
    decide(reviveDismissedReports(attempts, 1_000 + DISMISSED_REPORT_REVIVE_MS, null))?.messageId,
    "m1",
  );
});

test("acknowledging another report after folding makes the folded one a candidate again — acknowledgments before folding do not count", () => {
  const queue = [item("m1", "oliver", "2026-09-21T01:00:00Z")];
  const attempts = dismissReport([], "m1", 5_000);
  assert.deepEqual(reviveDismissedReports(attempts, 6_000, 4_000), attempts);
  assert.deepEqual(reviveDismissedReports(attempts, 6_000, 5_500), []);
  assert.equal(
    decideReportCall({
      queue,
      activeMessageId: null,
      attempts: reviveDismissedReports(attempts, 6_000, 5_500),
      signatures: {},
      blocked: false,
    })?.messageId,
    "m1",
  );
});

test("call again makes a folded report a candidate immediately — the blocking rules stay", () => {
  const queue = [item("m1", "oliver", "2026-09-21T01:00:00Z")];
  const attempts = recallReport(dismissReport([], "m1", 0), "m1");
  assert.equal(dismissedReportIds(attempts).size, 0);
  const input = { queue, activeMessageId: null, attempts, signatures: {}, blocked: false };
  assert.equal(decideReportCall(input)?.messageId, "m1");
  assert.equal(decideReportCall({ ...input, blocked: true }), null);
});

// Staging measurement (34369ac8): the moment a return acknowledged a report, the same employee's folded report revived
// and was called again right away, and that call reversed the return so the employee stayed beside us.

test("an employee being returned is not a report call candidate until reaching their seat — the next employee comes", () => {
  const queue = [
    item("m1", "oliver", "2026-09-21T01:00:00Z"),
    item("m2", "sophie", "2026-09-21T02:00:00Z"),
  ];
  const input = {
    queue,
    activeMessageId: null,
    attempts: [],
    // Right after pressing return, the snapshot still says "waiting on my call".
    signatures: { oliver: "waiting:mine:away", sophie: "idle:none:home" },
    blocked: false,
  };
  assert.equal(
    decideReportCall({ ...input, returningNpcIds: new Set(["oliver"]) })?.messageId,
    "m2",
  );
  assert.equal(
    decideReportCall({
      ...input,
      signatures: { oliver: "returning:none:away", sophie: "idle:none:home" },
    })?.messageId,
    "m2",
    "서버 스냅샷이 복귀 중이어도 부르지 않는다",
  );
});

test("a returned employee becomes a candidate again after reaching their seat", () => {
  const returning = new Set(["oliver"]);
  assert.equal(settleReturningNpcs(returning, { oliver: "waiting:mine:away" }), returning);
  assert.equal(settleReturningNpcs(returning, { oliver: "returning:none:away" }), returning);
  assert.equal(settleReturningNpcs(returning, { oliver: "idle:none:home" }).size, 0);
  const queue = [item("m1", "oliver", "2026-09-21T01:00:00Z")];
  assert.equal(
    decideReportCall({
      queue,
      activeMessageId: null,
      attempts: [],
      signatures: { oliver: "idle:none:home" },
      blocked: false,
      returningNpcIds: settleReturningNpcs(returning, { oliver: "idle:none:home" }),
    })?.messageId,
    "m1",
  );
});

test("if disconnected before the ack, the same report becomes a candidate again after reconnecting", () => {
  // If the socket drops before the response to a sent call, it is unknown whether the server received that call.
  // It used to stay "sent" and that report was not called again until a reload.
  const attempts = releaseUnacquiredReportCalls([sent("a", "idle:none:home")]);
  assert.deepEqual(attempts, [{ messageId: "a", outcome: "rejected", signature: "" }]);
  assert.equal(activeReportReleased(attempts, "a"), true);
  assert.equal(
    decideReportCall({
      queue: [A],
      activeMessageId: null,
      attempts,
      signatures: { "npc-1": "idle:none:home" },
      blocked: false,
    })?.messageId,
    "a",
  );
});

test("an acquired report does not become a refusal on disconnect — an employee already here is not called again", () => {
  const acquired: ReportAttempt = { ...sent("a", "idle:mine:away"), acquired: true };
  const others: ReportAttempt[] = [
    acquired,
    rejected("b", "idle:sock-1:home"),
    { messageId: "c", outcome: "dismissed", signature: "", dismissedAt: 1 },
  ];
  assert.deepEqual(releaseUnacquiredReportCalls(others), others);
});
