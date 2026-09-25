// A policy fragment that knows only "who speaks next." Moved as-is from conversation-engine.ts's
// takeGrant()/pollCandidates()/ block 5 of run() (candidate computation·polling·selectNextSpeaker)
// (a pure move, no behavior change).
//
// Why "Meeting" is in the name: it's "#3 — policy swap point" from spec §6. Right now this is
// the only floor policy, but phase 2 (open-chat simultaneous speaking) will put an
// OpenFloorController next to it, chosen in the constructor.
//
// Why the method is named next(): select()/decide() read as side-effect-free, but this method
// actually makes polling LLM calls when candidates need it.

import type { FloorInbox } from "./inbox";
import type { NpcRuntime } from "./npc-runtime";
import {
  eligibleParticipants,
  needsPolling,
  selectNextSpeaker,
  type ConversationMode,
  type Participant,
} from "./turn-policy";

/** The result if polling actually happened, otherwise null. null and an empty result differ — if
 * every polled participant's adapter fails, both raises/passes become empty arrays, but polling
 * still happened, so pollResult isn't null. */
export type PollReport = {
  raises: Array<{ npcId: string; reason: string }>;
  passes: string[];
  /**
   * Participants the poll **couldn't reach**. Kept separate from `passes` — silence and absence
   * are different.
   *
   * Previously a failure fell into neither bucket and vanished, so the decision became
   * `all-passed` and the screen showed "everyone PASSED" even though nobody actually passed.
   * Hermes explicitly rejects with 429 when the concurrent-run cap is exceeded
   * (`api_server.py:7154`), and that rejection evaporated here. Only requests that still failed
   * after the client retried remain here.
   *
   * `error` is the adapter's own rejection, kept so the engine can report it as it is; it is
   * not sent to clients.
   */
  failures: Array<{ npcId: string; reason: string; error?: unknown }>;
} | null;

export type FloorDecision =
  | { kind: "grant"; npcId: string }
  | { kind: "speaker"; npcId: string; pollResult: PollReport }
  | { kind: "all-passed"; pollResult: PollReport }
  | { kind: "no-candidates" };

/** The reason a mention grant was skipped. Kept as a union so this spot just grows when more
 * reasons are added later (spec §5.3). If `isBurnedOut()` is true, the gateway is down
 * ("backend_failing"); if not but the NPC still isn't eligible, its speaking quota is used up
 * ("quota_exhausted"). If both are true, backend_failing wins — it's the more urgent fact for
 * the operator. */
export type MentionSkipReason = "quota_exhausted" | "backend_failing";

/** Runs in sequential chunks. Prevents more polls than Hermes' max_concurrent_runs from firing
 * at once and being silently dropped with 429 (spec §3.5). */
function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export class MeetingFloorController {
  private readonly inbox: FloorInbox;
  private readonly mode: ConversationMode;
  private readonly maxConcurrentPolls: number;
  private readonly onPollStart: () => void;

  constructor(deps: {
    inbox: FloorInbox;
    mode: ConversationMode;
    maxConcurrentPolls: number;
    onPollStart: () => void;
  }) {
    this.inbox = deps.inbox;
    this.mode = deps.mode;
    this.maxConcurrentPolls = deps.maxConcurrentPolls;
    this.onPollStart = deps.onPollStart;
  }

  /**
   * Pops the next speaker off the inbox.
   *
   * Only mention grants go through the eligibility check — since the queue was added, a chain of
   * @-mentions could call the same NPC repeatedly past its quota. User grants are returned by the
   * inbox without a check, so this gate doesn't apply to them.
   */
  private takeGrant(ctx: {
    runtimeFor: (npcId: string) => NpcRuntime | undefined;
    remainingTurns: (npcId: string) => number;
    onSkippedGrant: (npcId: string, reason: MentionSkipReason) => void;
  }): string | null {
    return this.inbox.take(
      (npcId) => !(ctx.runtimeFor(npcId)?.isBurnedOut() ?? false) && ctx.remainingTurns(npcId) > 0,
      (npcId) => {
        // If isBurnedOut() is true, the gateway is down, not a quota problem — even if both
        // conditions hold, this one wins because it's the more urgent fact.
        const reason: MentionSkipReason = ctx.runtimeFor(npcId)?.isBurnedOut()
          ? "backend_failing"
          : "quota_exhausted";
        ctx.onSkippedGrant(npcId, reason);
      },
    );
  }

  async next(ctx: {
    participants: Participant[];
    runtimeFor: (npcId: string) => NpcRuntime | undefined;
    remainingTurns: (npcId: string) => number;
    lastSpeakerId: string | null;
    /** If false, returns all-passed without polling when there's no grant — preserves directed mode. */
    pollingAllowed: boolean;
    onSkippedGrant: (npcId: string, reason: MentionSkipReason) => void;
  }): Promise<FloorDecision> {
    const grantedNpcId = this.takeGrant(ctx);
    if (grantedNpcId !== null) {
      return { kind: "grant", npcId: grantedNpcId };
    }

    if (!ctx.pollingAllowed) {
      return { kind: "all-passed", pollResult: null };
    }

    const candidates = eligibleParticipants(ctx.participants, (npcId) =>
      ctx.runtimeFor(npcId)?.isBurnedOut() ? 0 : ctx.remainingTurns(npcId),
    );
    if (candidates.length === 0) {
      return { kind: "no-candidates" };
    }

    if (!needsPolling(this.mode)) {
      const speaker = selectNextSpeaker(this.mode, candidates, ctx.lastSpeakerId);
      if (!speaker) return { kind: "no-candidates" };
      return { kind: "speaker", npcId: speaker.npcId, pollResult: null };
    }

    const { raises, passes, failures } = await this.pollCandidates(
      candidates,
      ctx.runtimeFor,
      ctx.remainingTurns,
    );
    const pollResult: PollReport = {
      raises: raises.map((r) => ({ npcId: r.npcId, reason: r.reason })),
      passes,
      failures,
    };

    if (raises.length === 0) {
      return { kind: "all-passed", pollResult };
    }

    const raisedCandidates = candidates.filter((c) => raises.some((r) => r.npcId === c.npcId));
    const speaker = selectNextSpeaker(this.mode, raisedCandidates, ctx.lastSpeakerId);
    if (!speaker) return { kind: "all-passed", pollResult };
    return { kind: "speaker", npcId: speaker.npcId, pollResult };
  }

  /**
   * Splits candidates into chunks of maxConcurrentPolls and polls each chunk in parallel
   * (chunks run sequentially relative to each other).
   *
   * A failed participant doesn't halt the meeting (they simply don't speak that round). It's
   * still **recorded in `failures`, distinct from silence** — previously it was silently
   * dropped, so "everyone PASSED" and "reached nobody" looked identical on screen.
   */
  private async pollCandidates(
    candidates: Participant[],
    runtimeFor: (npcId: string) => NpcRuntime | undefined,
    remainingTurns: (npcId: string) => number,
  ): Promise<{
    raises: Array<{ npcId: string; reason: string }>;
    passes: string[];
    failures: Array<{ npcId: string; reason: string; error?: unknown }>;
  }> {
    this.onPollStart();

    const raises: Array<{ npcId: string; reason: string }> = [];
    const passes: string[] = [];
    const failures: Array<{ npcId: string; reason: string; error?: unknown }> = [];

    for (const group of chunk(candidates, this.maxConcurrentPolls)) {
      const results = await Promise.allSettled(
        group.map(async (c) => {
          const runtime = runtimeFor(c.npcId)!;
          const remaining = remainingTurns(c.npcId);
          try {
            const parsed = await runtime.poll(remaining);
            return { npcId: c.npcId, parsed };
          } catch (err) {
            // We need to know which NPC failed to record it — rethrowing as-is leaves no npcId
            // on Promise.allSettled's reason.
            throw Object.assign(new Error("poll failed"), {
              npcId: c.npcId,
              cause: err,
            });
          }
        }),
      );

      for (const result of results) {
        if (result.status === "rejected") {
          const reason = result.reason as { npcId?: string; cause?: unknown };
          const cause = reason?.cause;
          failures.push({
            npcId: reason?.npcId ?? "unknown",
            reason: cause instanceof Error ? cause.message : String(cause ?? "unknown"),
            error: cause,
          });
          continue;
        }
        const { npcId, parsed } = result.value;
        if (parsed.wantsToSpeak) {
          raises.push({ npcId, reason: parsed.reason });
        } else {
          passes.push(npcId);
        }
      }
    }

    return { raises, passes, failures };
  }
}
