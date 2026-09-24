// The conversation loop for a single channel. Owns the transcript, asks FloorController
// "who's next", and hands the floor to the selected NpcRuntime. In meeting policy there's
// only ever one at a time.
//
// The turn loop for multi-party conversation. Only the adapter is known here — no gateway,
// socket, or DB.
// A port of MeetingBroker.run()'s loop structure (meeting-broker.js:78-184) onto the
// adapter — gateway calls become NpcAdapter.execute() calls, and policy decisions are
// delegated to turn-policy.ts.

import type { EngineParticipant } from "./types";
import { Transcript, USER_SPEAKER_ID, type Turn } from "./transcript";
import type { TurnTimeoutConfig } from "./turn-timeout";
import { FloorInbox } from "./inbox";
import { DEFAULT_IDLE_MS, DEFAULT_MAX_MS, NpcRuntime } from "./npc-runtime";
import { MeetingFloorController, type MentionSkipReason } from "./floor-controller";
import type { ConversationMode, Participant } from "./turn-policy";

// Defined in types.ts — this keeps npc-runtime from pointing back at this file.
// Callers (meeting-discussion, tests, the conversation-engine shell) keep importing
// from here, so it's kept as a re-export.
export type { EngineParticipant } from "./types";

/** Meeting runtime control submode. Ported from meeting-broker.js:53 — a separate axis
 * from EngineConfig.mode (peer/meeting/group, the participant structure/policy axis).
 * auto=proceeds automatically, manual=waits after every round, directed=receives only
 * directSpeak with no polling. */
export type RunMode = "auto" | "manual" | "directed";

/** Why the loop ended. Reported together via onEnd. */
export type EngineEndReason =
  "max_turns" | "consecutive_passes" | "consecutive_failures" | "no_candidates" | "stopped";

export type EngineCallbacks = {
  onPollStart?: () => void;
  onPollResult?: (
    raises: Array<{ npcId: string; reason: string }>,
    passes: string[],
    /** Participants the poll couldn't reach. Reported separately from silence (passes). */
    failures: Array<{ npcId: string; reason: string }>,
  ) => void;
  onTurnStart?: (npcId: string, displayName: string) => void;
  onTurnChunk?: (npcId: string, chunk: string) => void;
  /** meta is only populated when the turn ended aborted — in that case fullResponse is
   * whatever partial text was streamed up to that point (may be empty) and is not recorded
   * in the transcript.
   *
   * **Called on all five branches** — successful speech, a turn that left only a mention,
   * an empty response, an adapter exception, and a timeout. The client's streaming speech
   * bubble is only closed by the done:true this callback produces, and the same signal also
   * clears the "speaking" indicator. It used to be called only on success and timeout, so an
   * empty response or a plain exception left the bubble open forever.
   *
   * meta.reason distinguishes the branch: `empty_after_mention` (left only a mention) /
   * `empty_response` (no usable text) / `adapter_error` / `timeout:<kind>`. */
  onTurnEnd?: (
    npcId: string,
    fullResponse: string,
    meta?: { aborted: true; reason: string },
  ) => void;
  onEnd?: (turns: Turn[], reason: EngineEndReason) => void;
  onError?: (err: unknown, npcId: string) => void;
  /** When RunMode changes. source: "user" when changed via the user's setMode call (batched
   * at drain time — hybridMode's automatic return also goes through setMode, so it's also
   * reported as "user"; this is a quirk ported as-is from meeting-broker.js:275-277 and left
   * unfixed), or "system" right when directSpeak promotes hybridMode from auto→manual
   * (meeting-broker.js:239-242). */
  onModeChanged?: (mode: RunMode, source: "user" | "system") => void;
  /** When manual/directed mode starts waiting for the next input. manual doesn't send the
   * actual poll result — it always sends the fixed empty value { raises: [], passes: [] }
   * (ported as-is from meeting-broker.js:159 — a quirk where the real poll result isn't
   * carried). The wait after directed and after direct-speak is null. */
  onWaitingInput?: (pollResult: { raises: unknown[]; passes: string[] } | null) => void;
  /**
   * An NPC that was mentioned but had no speaking quota left, so it was skipped. Reported
   * rather than silently dropped (same family as meeting-discussion's onParticipantsExcluded).
   *
   * Why a callback rather than a transcript turn: turning it into a turn would eat into the
   * maxTotalTurns budget, inflate the totalTurns tally, and get carried in the prompt
   * history where NPCs start postponing to talk about their quota.
   *
   * Why it passes (npcId, reason) rather than a finished sentence: the engine has no
   * user-facing strings at all. Display text lives in i18n locales and is rendered by the
   * client.
   *
   * Why reason is a union: merging "quota_exhausted" (speaking quota used up) with
   * "backend_failing" (burnout from consecutive gateway failures) would make a dead gateway
   * look like ordinary quota exhaustion — the same confusion already avoided in endReason
   * (§8) is avoided here too.
   */
  onMentionSkipped?: (npcId: string, reason: MentionSkipReason) => void;
};

export type EngineQuota = {
  maxTurnsPerAgent: number;
  maxTotalTurns: number;
  /** peer mode has no hand-raising, so there's no concept of consecutive PASS — optional.
   * Defaults to 2 (same as the broker's default). */
  maxConsecutivePasses?: number;
  cooldownMs: number;
};

export type EngineConfig = {
  mode: ConversationMode;
  topic: string;
  participants: EngineParticipant[];
  quota: EngineQuota;
  /** Matches Hermes gateway.api_server.max_concurrent_runs. Defaults to 4. */
  maxConcurrentPolls?: number;
  /** Number of recent turns to carry as history. Defaults to 10. */
  historyLimit?: number;
  now?: () => number;
  /** Initial RunMode. Defaults to "auto" — omitting this behaves the same as before the
   * control surface was introduced. */
  initialRunMode?: RunMode;
  /** manual mode automatically returns to auto after an idle period. Ported from
   * meeting-broker.js:54-55, 162-167. */
  hybridMode?: boolean;
  hybridAutoResumeMs?: number | null;
  /** Two-tier turn timeout (§3.5). If omitted: idleMs 180s (same as the old
   * turnTimeoutMs)/maxMs 600s. */
  turnTimeout?: Partial<TurnTimeoutConfig>;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ChannelRuntime {
  private readonly config: EngineConfig;
  private readonly callbacks: EngineCallbacks;
  private readonly transcript = new Transcript();
  private readonly now: () => number;

  private running = false;
  private consecutivePasses = 0;
  /**
   * NpcRuntime per npcId. Along with prompt assembly, timeouts, streaming sanitization, and
   * mention parsing, this also holds the consecutive-failure counter (owned per NPC — it used
   * to be engine-global, so one NPC's dead backend could end the whole meeting after 3
   * consecutive failures).
   */
  private readonly runtimes: Map<string, NpcRuntime>;
  private endReason: EngineEndReason | null = null;
  private lastSpeakerId: string | null = null;
  private userMessageQueue: Array<{ userName: string; content: string }> = [];

  // Control surface state — ported from meeting-broker.js:52-66
  private runMode: RunMode;
  private readonly hybridMode: boolean;
  private readonly hybridAutoResumeMs: number | null;
  private autoResumeTimer: ReturnType<typeof setTimeout> | null = null;
  private commandQueue: Array<{ type: "setMode"; mode: string }> = [];
  /** Queue of floor grants. Replaces the old single slot — a mention no longer silently
   * vanishes. */
  private readonly inbox = new FloorInbox();
  /** Policy for "who speaks next". The policy swap point from spec §6 — see
   * floor-controller.ts. */
  private readonly floor: MeetingFloorController;
  private waitResolve: (() => void) | null = null;
  /** A release that arrived before the wait was armed. This is a latch (boolean), not a
   * counter — see the releaseWait comment. */
  private pendingRelease = false;
  /** Target for abortCurrentTurn — populated only while speak() is in progress. Matches
   * meeting-broker.js:_currentSessionKey/_currentAgentId. */
  private current: NpcRuntime | null = null;

  constructor(config: EngineConfig, callbacks: EngineCallbacks) {
    this.config = config;
    this.callbacks = callbacks;
    this.now = config.now ?? Date.now;
    this.runMode = config.initialRunMode ?? "auto";
    this.hybridMode = config.hybridMode ?? false;
    this.hybridAutoResumeMs = config.hybridAutoResumeMs ?? null;
    this.runtimes = new Map(
      config.participants.map((p) => [
        p.npcId,
        new NpcRuntime(p, {
          transcript: this.transcript,
          topic: config.topic,
          allParticipants: config.participants,
          maxTotalTurns: config.quota.maxTotalTurns,
          historyLimit: config.historyLimit ?? 10,
          turnTimeout: {
            idleMs: config.turnTimeout?.idleMs ?? DEFAULT_IDLE_MS,
            maxMs: config.turnTimeout?.maxMs ?? DEFAULT_MAX_MS,
          },
          now: this.now,
        }),
      ]),
    );
    this.floor = new MeetingFloorController({
      inbox: this.inbox,
      mode: config.mode,
      maxConcurrentPolls: config.maxConcurrentPolls ?? 4,
      onPollStart: () => this.callbacks.onPollStart?.(),
    });
  }

  isRunning(): boolean {
    return this.running;
  }

  addUserMessage(userName: string, content: string): void {
    this.userMessageQueue.push({ userName, content });
    this.consecutivePasses = 0;
  }

  remainingTurns(npcId: string): number {
    return Math.max(0, this.config.quota.maxTurnsPerAgent - this.transcript.turnCountFor(npcId));
  }

  stop(): void {
    this.running = false;
    this.clearAutoResumeTimer();
    this.abortCurrentTurn();
    this.releaseWait();
  }

  /**
   * Changes the RunMode. Ported from meeting-broker.js:213-225.
   * Preserved defect: if mode isn't one of "auto"/"manual"/"directed", this silently does
   * nothing — no error, no callback, and the caller has no way to know it failed. Left as-is
   * during migration and not fixed (a candidate for a separate follow-up fix).
   */
  setMode(mode: string): void {
    if (mode !== "auto" && mode !== "manual" && mode !== "directed") return;
    this.commandQueue.push({ type: "setMode", mode });
    this.abortCurrentTurn();
    this.clearAutoResumeTimer();
    this.releaseWait();
  }

  /**
   * Releases manual mode's wait to advance to the next round. Ported from
   * meeting-broker.js:227-234.
   * The command pushed onto commandQueue is not consumed by drainCommands — the original
   * broker also ignores the "nextTurn" type the same way (broker.js:262-274), so the only
   * real effect is releasing the wait. The observable behavior would be identical without
   * queuing it, but it's kept to preserve the structure being ported.
   */
  nextTurn(): void {
    if (this.runMode !== "manual") return;
    this.releaseWait();
  }

  /**
   * Forces the floor onto a given NPC. Ported from meeting-broker.js:236-247.
   * Preserved defect: this doesn't validate that npcId is in the participant list. If run()
   * looks for that npcId among participants on the next loop and fails, it silently has no
   * one speak and returns to waiting (the same silent failure as when the original
   * meeting-broker.js's run() can't find the agent — left unfixed).
   *
   * Like setMode(), calls clearAutoResumeTimer() immediately (doesn't wait for the drain).
   * Every time the manual wait is released, run() unconditionally re-arms a new
   * auto-resume timer (see run() step 5 above), so if this doesn't clear it first, the old
   * timer's handle gets overwritten by the new timer and the old one keeps running
   * orphaned, its field reference lost — it then expires later, unrelated to the user's
   * subsequent intervention, and jumps to auto (the clearAutoResumeTimer() that
   * takeGrant() calls when consuming the floor alone can't prevent this race — by that point
   * the field has already been overwritten by the new timer).
   */
  directSpeak(npcId: string): void {
    this.inbox.push(npcId, "user");
    this.abortCurrentTurn();
    this.clearAutoResumeTimer();
    if (this.hybridMode && this.runMode === "auto") {
      this.runMode = "manual";
      this.callbacks.onModeChanged?.("manual", "system");
    }
    this.releaseWait();
  }

  /** Requests an abort on the runtime currently holding the floor. In meeting policy this
   * pointer is always 0 or 1. Ported from meeting-broker.js:249-253. */
  abortCurrentTurn(): void {
    this.current?.abort();
  }

  /** Arms the wait promise first (need), then calls the callback — an order that stays safe
   * even if the callback synchronously calls stop()/nextTurn()/setMode()/directSpeak() to
   * release the wait immediately (the original calls the callback before arming the wait, so
   * a synchronous release attempted from the callback misses a wait that isn't armed yet, and
   * the wait armed afterward never gets released — this order was adjusted only for test
   * determinism. Observable timing/ordering is unchanged).
   */
  private armWait(): Promise<void> {
    // If a release already arrived before the wait was armed, consume it and pass straight
    // through. Without this latch, releaseWait() wouldn't find waitResolve and would be
    // silently dropped, and the wait armed right after would never be woken — leaving the
    // meeting stuck.
    if (this.pendingRelease) {
      this.pendingRelease = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waitResolve = resolve;
    });
  }

  private releaseWait(): void {
    if (this.waitResolve) {
      this.waitResolve();
      this.waitResolve = null;
      return;
    }
    // No wait has been armed yet — remember it instead of dropping it. Why this is a
    // **latch** and not a counter: even if the release arrives twice, only one wait should
    // pass through. If it were counted, the accumulated releases would let subsequent waits
    // pass through one after another, and manual mode would effectively behave like auto.
    this.pendingRelease = true;
  }

  private clearAutoResumeTimer(): void {
    if (this.autoResumeTimer) {
      clearTimeout(this.autoResumeTimer);
      this.autoResumeTimer = null;
    }
  }

  /**
   * Consumes only setMode commands. Floor grants are held separately by FloorInbox.
   *
   * This used to also drain grants here, acting as a "only one survives" slot. Under that
   * structure a mention could be dropped with no log — now the inbox keeps them in order.
   */
  private drainCommands(): void {
    let modeChanged = false;
    while (this.commandQueue.length > 0) {
      const cmd = this.commandQueue.shift()!;
      if (cmd.type === "setMode") {
        this.runMode = cmd.mode as RunMode;
        modeChanged = true;
      }
    }
    if (modeChanged) this.callbacks.onModeChanged?.(this.runMode, "user");
  }

  async run(): Promise<void> {
    this.running = true;
    this.endReason = null;
    // If the previous run() leaves its failure counters behind, the second run() starts with
    // a budget of 1 instead of 3.
    for (const r of this.runtimes.values()) r.resetFailures();

    while (this.running && !this.isFinished()) {
      // 1. Drain the command queue (setMode)
      this.drainCommands();

      // 2. Drain the user message queue
      while (this.userMessageQueue.length > 0) {
        const { userName, content } = this.userMessageQueue.shift()!;
        this.transcript.add(USER_SPEAKER_ID, userName, content, this.now());
        this.consecutivePasses = 0;
      }

      // 3+5. Decide the next speaker — a direct grant (always highest priority regardless of
      //    runMode) or candidate generation → (if needed) polling → selection. Delegated to
      //    MeetingFloorController.next() (floor-controller.ts).
      //    Preserved defect: if npcId can't be found in the participant list, no one silently
      //    speaks.
      //
      // In directed mode with a completely empty inbox, skip calling floor.next() and go
      // straight to arming the wait. next() is async, so awaiting its result necessarily
      // inserts one microtask tick, whereas the original code's synchronous takeGrant()
      // reached armWait() within the same event loop turn without that tick — a test where
      // directSpeak() is called in the same synchronous section as run() depends on this tick
      // (if that tick existed, the push would happen before armWait() and releaseWait() would
      // be nullified). When the inbox isn't empty this optimization isn't needed — a grant is
      // already queued, so next() will pick it up whether it's this tick or the next.

      const decision = await this.floor.next({
        participants: this.participantsView(),
        runtimeFor: (npcId) => this.runtimes.get(npcId),
        remainingTurns: (npcId) => this.remainingTurns(npcId),
        lastSpeakerId: this.lastSpeakerId,
        // directed only receives direct grants with no polling. Since grants are checked
        // first, without this flag an LLM poll that didn't exist before would fire every
        // round when there's no grant.
        pollingAllowed: this.runMode !== "directed",
        onSkippedGrant: (npcId, reason) => this.callbacks.onMentionSkipped?.(npcId, reason),
      });

      if (decision.kind === "grant") {
        this.clearAutoResumeTimer();
        const runtime = this.runtimes.get(decision.npcId);
        if (runtime) {
          await this.speak(runtime);
        }
        if (this.runMode !== "auto") {
          const waiting = this.armWait();
          this.callbacks.onWaitingInput?.(null);
          await waiting;
        } else {
          await sleep(this.config.quota.cooldownMs);
        }
        continue;
      }

      // 4. directed: waits only, with no polling — the next directSpeak is handled in step 3
      //    of the next loop. Ported from meeting-broker.js:169-173.
      if (this.runMode === "directed") {
        const waiting = this.armWait();
        this.callbacks.onWaitingInput?.(null);
        await waiting;
        continue;
      }

      if (decision.kind === "no-candidates") {
        // Distinguish why there's no one. Everyone exhausting their failure budget and
        // everyone using up their quota are operationally very different situations — the
        // former means the backend is dead.
        const seated = this.config.participants.filter((p) => p.seated);
        const allBurnedOut =
          seated.length > 0 &&
          seated.every((p) => this.runtimes.get(p.npcId)?.isBurnedOut() ?? false);
        this.endReason = allBurnedOut ? "consecutive_failures" : "no_candidates";
        break;
      }

      // Notify only when pollResult !== null, and when that's true, notify regardless of
      // content — if every polled participant's adapter fails, raises/passes both become
      // empty arrays, but the client still needs to know polling happened at all. Since the
      // all-passed/speaker branches share the same field (decision.pollResult), this is
      // pulled out ahead of the kind check — structurally preventing a fix applied to one
      // branch from being missed on the other.
      if (decision.pollResult) {
        this.callbacks.onPollResult?.(
          decision.pollResult.raises,
          decision.pollResult.passes,
          decision.pollResult.failures,
        );
      }

      if (decision.kind === "all-passed") {
        this.consecutivePasses++;
        if (this.consecutivePasses >= this.maxConsecutivePasses()) {
          this.endReason = "consecutive_passes";
          break;
        }
      } else {
        this.consecutivePasses = 0;
        const runtime = this.runtimes.get(decision.npcId);
        if (runtime) {
          await this.speak(runtime);
          // A failed turn leaves nothing in the transcript, so it can't advance any other
          // termination condition — a burned-out NPC drops out of the candidate filter on
          // the next loop (applies to peer/group/meeting alike).
        }
      }

      // 6. manual always waits at the end of every round regardless of whether anyone spoke
      //    (no cooldown). Only auto keeps going after a cooldown. Ported from
      //    meeting-broker.js:159-167.
      if (this.runMode === "manual") {
        const waiting = this.armWait();
        this.callbacks.onWaitingInput?.({ raises: [], passes: [] });
        await waiting;

        if (this.hybridMode && this.hybridAutoResumeMs && this.runMode === "manual") {
          // Assigning directly to the field would lose the previous timer's handle — that
          // timer would stay alive, uncancellable, and later expire, wiping out the
          // **current** timer's handle too via this.autoResumeTimer = null. If the user
          // presses nextTurn repeatedly, an orphan piles up every round, and while manual
          // control is still ongoing, an old timer expires and jumps to auto.
          //
          // Why the cancellation lives **here** and not in nextTurn(): this is the only
          // place where the timer handle gets overwritten. If cancellation were planted at
          // every path that releases the wait (nextTurn/setMode/directSpeak/stop), a fifth
          // path would miss it again — this is in fact how this defect happened.
          this.clearAutoResumeTimer();
          this.autoResumeTimer = setTimeout(() => {
            this.autoResumeTimer = null;
            this.setMode("auto");
          }, this.hybridAutoResumeMs);
        }
      } else {
        await sleep(this.config.quota.cooldownMs);
      }
    }

    this.running = false;
    this.clearAutoResumeTimer();
    this.callbacks.onEnd?.(this.transcript.all(), this.resolveEndReason());
  }

  private resolveEndReason(): EngineEndReason {
    if (this.endReason) return this.endReason;
    if (this.transcript.all().length >= this.config.quota.maxTotalTurns) return "max_turns";
    if (this.consecutivePasses >= this.maxConsecutivePasses()) return "consecutive_passes";
    return "stopped";
  }

  private maxConsecutivePasses(): number {
    return this.config.quota.maxConsecutivePasses ?? 2;
  }

  /**
   * Builds a fresh participant snapshot every round to pass to turn-policy
   * (eligibleParticipants/selectNextSpeaker). Transcript is the sole source of truth for
   * lastSpokeAt/turnCount — EngineParticipant's own fields are never updated from their
   * creation-time value (always 0), so referencing them directly would make fairness
   * selection (meeting/group's "participant who hasn't spoken the longest") effectively
   * lock onto the first candidate in the array. Deriving it fresh each time removes any
   * chance of forgetting to update it.
   */
  private participantsView(): Participant[] {
    return this.config.participants.map((p) => ({
      npcId: p.npcId,
      displayName: p.displayName,
      seated: p.seated,
      turnCount: this.transcript.turnCountFor(p.npcId),
      lastSpokeAt: this.transcript.lastSpokeAt(p.npcId),
    }));
  }

  private isFinished(): boolean {
    return (
      this.transcript.all().length >= this.config.quota.maxTotalTurns ||
      this.consecutivePasses >= this.maxConsecutivePasses()
    );
  }

  /** Grants the floor and receives the streamed response, recording it in the transcript. */
  private async speak(runtime: NpcRuntime): Promise<void> {
    this.callbacks.onTurnStart?.(runtime.npcId, runtime.displayName);
    this.current = runtime;

    // takeTurn doesn't throw — every failure is returned as a SpeakOutcome.
    // That way the callback-invocation condition lives in one place (here).
    const outcome = await runtime.takeTurn(this.remainingTurns(runtime.npcId), {
      onChunk: (chunk) => this.callbacks.onTurnChunk?.(runtime.npcId, chunk),
    });
    this.current = null;

    if (outcome.kind === "spoke") {
      this.transcript.add(runtime.npcId, runtime.displayName, outcome.text, this.now());
      this.lastSpeakerId = runtime.npcId;
      this.callbacks.onTurnEnd?.(runtime.npcId, outcome.text);
      // Don't call the directSpeak() method — that one is for user-directed grants and
      // interrupts the in-progress turn via abortCurrentTurn() and promotes hybridMode to
      // manual. A mention is just a hint after the turn is already done, so it only goes
      // into the inbox.
      if (outcome.mentionNpcId) this.inbox.push(outcome.mentionNpcId, "mention");
      return;
    }

    if (outcome.kind === "empty") {
      // Either a response that had only "TO: name" and no body, or a turn with no usable
      // text at all. It's not recorded in the transcript, but **the speech bubble is still
      // closed** — the client's streaming speech bubble is only closed by the done:true that
      // onTurnEnd produces, and the same signal also clears the "speaking" indicator. Why the
      // two reasons are distinguished: a turn that left only a mention is a normal flow where
      // the next speaker is already decided, while a turn that produced nothing at all is a
      // situation where the backend should be suspected.
      this.callbacks.onTurnEnd?.(runtime.npcId, outcome.partialText, {
        aborted: true,
        reason: outcome.mentionNpcId ? "empty_after_mention" : "empty_response",
      });
      // Even when the body is empty and treated as a failure, the mention itself is still a
      // valid signal of intent.
      if (outcome.mentionNpcId) this.inbox.push(outcome.mentionNpcId, "mention");
      return;
    }

    this.callbacks.onError?.(outcome.error, runtime.npcId);
    // Close the speech bubble whether it's a timeout or a plain exception. It used to close
    // only on timeout, so if the adapter blew up for any other reason, only onError fired and
    // the bubble stayed open forever.
    this.callbacks.onTurnEnd?.(runtime.npcId, outcome.partialText, {
      aborted: true,
      reason: outcome.timedOut ? `timeout:${outcome.timedOut.kind}` : "adapter_error",
    });
  }
}
