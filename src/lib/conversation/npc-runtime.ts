// What a single NPC owns for itself: prompt assembly, turn timeout, streaming sanitization,
// mention parsing.
// Moved here as-is from speak()/pollCandidates() in conversation-engine.ts (a pure move, no
// behavior change).
// Transcript recording and callback emission are the channel's (engine's) job and don't live
// here — SpeakOutcome is that boundary.

const {
  formatPollMessage,
  formatSpeakMessage,
  parseHandRaise,
  sanitizeSpokenResponse,
  sanitizeStreamingSpokenResponse,
  // eslint-disable-next-line @typescript-eslint/no-require-imports
} = require("../meeting-formatter.js") as typeof import("../meeting-formatter.js");

import { parseMention } from "./mention";
import { Transcript } from "./transcript";
import { createTurnTimeout, type TurnTimeoutConfig } from "./turn-timeout";
import type { EngineParticipant } from "./types";

/**
 * Cuts the turn off once the signal (assistant delta / tool progress) stalls this long.
 *
 * This is new behavior, not a port. `turnTimeoutMs` at meeting-broker.js:72 was a dead setting
 * read nowhere but its own initializer, and the old broker never actually timed out a turn —
 * a stalled agent held the meeting hostage forever. Only the value (180s) was carried over
 * from that dead setting.
 *
 * There's a cost: the idle timer only resets on onDelta/onToolProgress, but the old gateway
 * adapter never called onToolProgress and only forwarded onDelta. So an NPC that quietly runs
 * a tool for more than 3 minutes — a turn that would have finished before — now gets cut off
 * and reported as an error. The spec's "reset the idle timer on tool.progress" is only
 * implemented on the current Hermes path.
 */
export const DEFAULT_IDLE_MS = 180_000;
/** An absolute ceiling comfortably larger than idle. Stops runaway turns without killing a normal multi-tool-call turn. */
export const DEFAULT_MAX_MS = 600_000;

/**
 * The consecutive-failure limit. Once a turn fails this many times in a row, it drops out of
 * the engine's candidate filter (isBurnedOut()).
 *
 * A failed turn leaves nothing in the transcript, so none of maxTotalTurns, remainingTurns,
 * or consecutivePasses advance — in poll-less peer mode there is no other brake at all, so
 * the loop spins forever (observed in review: over 50 iterations with maxTotalTurns 3).
 *
 * Why 3: at 1, a single transient network error kills the meeting; set it too high and the
 * user just waits longer when the backend is fully down. Three in a row is hard to call
 * "transient" anymore. Not pulled out into config — there's no config path that reads this
 * value yet.
 */
export const MAX_CONSECUTIVE_FAILURES = 3;

export type NpcRuntimeDeps = {
  transcript: Transcript;
  topic: string;
  allParticipants: EngineParticipant[];
  maxTotalTurns: number;
  historyLimit: number;
  turnTimeout: TurnTimeoutConfig;
  now: () => number;
  /** Language of the meeting turn prompts (meeting-formatter.js). Omitted means Korean, as before
   * locales existed; null (no language cookie) means English. */
  locale?: string | null;
};

export type SpeakOutcome =
  | { kind: "spoke"; text: string; mentionNpcId: string | null }
  // partialText: the text already streamed to the screen. We include it even on a failed
  // turn because the client's speech bubble doesn't close without onTurnEnd — the content
  // passed at close time must match what's already on screen, so the finalized bubble
  // doesn't look different from mid-stream.
  | { kind: "empty"; mentionNpcId: string | null; partialText: string }
  | { kind: "error"; error: unknown; partialText: string; timedOut: { kind: string } | null };

export class NpcRuntime {
  readonly npcId: string;
  readonly displayName: string;
  readonly participant: EngineParticipant;
  private readonly deps: NpcRuntimeDeps;
  private failures = 0;

  constructor(participant: EngineParticipant, deps: NpcRuntimeDeps) {
    this.participant = participant;
    this.npcId = participant.npcId;
    this.displayName = participant.displayName;
    this.deps = deps;
  }

  /**
   * Resets the failure budget for a new run().
   *
   * Unlike the updates driven by turn results (noteFailure/noteSuccess), this is **something
   * the caller decides** — the NPC itself has no way to know "a new meeting is starting."
   * That's why this is the only public one.
   */
  resetFailures(): void {
    this.failures = 0;
  }

  private noteFailure(): void {
    this.failures += 1;
  }

  private noteSuccess(): void {
    this.failures = 0;
  }

  /** Has this NPC exhausted its failure budget? A burned-out NPC drops out of the candidates. */
  isBurnedOut(): boolean {
    return this.failures >= MAX_CONSECUTIVE_FAILURES;
  }

  /** Requests an abort on this NPC's adapter while it is currently speaking. Ported from meeting-broker.js:249-253. */
  abort(): void {
    this.participant.adapter.abort?.(this.participant.sessionKey)?.catch(() => {});
  }

  /** Runs one hand-raise poll. A failure (reject) is passed straight through to the caller
   * (pollCandidates) — deciding not to put a failed participant into either raises or passes
   * is the engine's job. */
  async poll(remaining: number): Promise<{ wantsToSpeak: boolean; reason: string }> {
    const currentTurn = this.deps.transcript.all().length;
    const maxTurns = this.deps.maxTotalTurns;
    const recentTurns = this.deps.transcript.recent(3);
    const pollMsg = formatPollMessage(
      this.deps.topic,
      recentTurns,
      { displayName: this.participant.displayName },
      currentTurn,
      maxTurns,
      remaining,
      this.participant.passPolicy ?? null,
      this.deps.locale,
    );
    const { response } = await this.participant.adapter.execute({
      sessionKey: `${this.participant.sessionKey}-poll`,
      prompt: pollMsg,
      instructions: this.participant.instructions ?? undefined,
      // A poll carries no history, but it's still a multi-party conversation — the NPC's
      // persistent session must not accumulate "SPEAK:/PASS" exchanges.
      multiParty: true,
    });
    return parseHandRaise(response, this.deps.locale);
  }

  /**
   * Takes the floor, receives a streamed response, and extracts a mention. Never throws —
   * every failure is returned as a SpeakOutcome. That way the conditions for calling back
   * (transcript recording, onTurnEnd, etc.) stay collected in one place, the engine.
   */
  async takeTurn(
    remaining: number,
    hooks: { onChunk: (chunk: string) => void },
  ): Promise<SpeakOutcome> {
    const currentTurn = this.deps.transcript.all().length;
    const maxTurns = this.deps.maxTotalTurns;
    const historyLimit = this.deps.historyLimit;
    const recentTurns = this.deps.transcript.recent(historyLimit);

    // A judgment call on prompt/history duplication: formatSpeakMessage folds recentTurns
    // directly into the prompt text as-is. Sending conversationHistory alongside it duplicates
    // the same content in both the prompt and the structured history. Since D9 (behavior
    // preservation) is this step's success criterion, we keep the prompt assembly unchanged
    // (option a) and add conversationHistory as a separate field — accepting wasted tokens
    // in exchange for zero regression risk. (An earlier implementation's comment claimed the
    // prompt was "byte-for-byte identical," but that wasn't actually true — passPolicy and
    // role were both missing at the time.)
    const participantsForFormat = this.deps.allParticipants.map((p) => ({
      displayName: p.displayName,
      role: p.role || "Participant",
    }));
    const message = formatSpeakMessage(
      this.deps.topic,
      participantsForFormat,
      recentTurns,
      { displayName: this.participant.displayName },
      currentTurn,
      maxTurns,
      remaining,
      this.deps.locale,
    );

    return this.speakWithPrompt(message, hooks);
  }

  /**
   * Speaks once, given the supplied prompt. Never throws — every failure is returned as a
   * SpeakOutcome.
   *
   * Split from takeTurn because: assembling the prompt differs between a meeting (topic,
   * participants, turn count) and free chat (who asked what), but taking the prompt, making
   * it speak, and getting the response back — the two-tier timeout, streaming sanitization,
   * mention parsing — is exactly the same. Only that shared half lives here.
   */
  async speakWithPrompt(
    prompt: string,
    hooks: { onChunk: (chunk: string) => void },
  ): Promise<SpeakOutcome> {
    const historyLimit = this.deps.historyLimit;
    let rawText = "";
    let emittedText = "";
    // Two-tier timeout (§3.5) — idle resets via touch() every time onDelta/onToolProgress
    // (an activity signal) comes in, while max is an absolute ceiling that nothing resets.
    // Whichever fires first, adapter.abort() cuts this turn and rejects execute()'s pending
    // promise so the meeting loop moves on to the next turn — the meeting as a whole doesn't
    // stop (same as the old turnTimeoutMs failure handling).
    let timedOutKind: string | null = null;
    try {
      const { response } = await new Promise<{ response: string }>((resolve, reject) => {
        const timeout = createTurnTimeout(this.deps.turnTimeout, (kind) => {
          timedOutKind = kind;
          this.participant.adapter.abort?.(this.participant.sessionKey)?.catch(() => {});
          reject(new Error(`turn timeout (${kind})`));
        });
        this.participant.adapter
          .execute({
            sessionKey: this.participant.sessionKey,
            prompt,
            instructions: this.participant.instructions ?? undefined,
            // The engine owns the transcript. The first turn has empty history, but it's
            // still one turn of a multi-party conversation, so its send path must not differ
            // from the second turn onward.
            multiParty: true,
            conversationHistory: this.deps.transcript.toConversationHistory(historyLimit),
            onDelta: (chunk) => {
              timeout.touch();
              rawText += chunk;
              const sanitizedText = sanitizeStreamingSpokenResponse(rawText);
              const delta = sanitizedText.slice(emittedText.length);
              emittedText = sanitizedText;
              if (delta) hooks.onChunk(delta);
            },
            onToolProgress: () => {
              timeout.touch();
            },
          })
          .then((result) => {
            timeout.clear();
            resolve(result);
          })
          .catch((err) => {
            timeout.clear();
            reject(err);
          });
      });

      const sanitizedResponse = sanitizeSpokenResponse(response || rawText);
      if (sanitizedResponse) {
        // Extracts the mention and leaves only the body, with the control line stripped, for the screen/transcript.
        const mention = parseMention(
          sanitizedResponse,
          this.deps.allParticipants.map((p) => ({ npcId: p.npcId, displayName: p.displayName })),
          this.participant.npcId,
        );

        if (mention.text) {
          this.noteSuccess();
          return { kind: "spoke", text: mention.text, mentionNpcId: mention.npcId };
        }
        // A response that's only "TO: name" with no body — once parseMention strips the
        // mention line, nothing is left. sanitizedResponse itself isn't empty so it passes
        // the gate above, but there's neither anything to show on screen nor anything to
        // record in the transcript. Treated the same as the catch-all below: "a turn with no
        // usable text at all." The mention itself is still a valid signal of intent though,
        // so mentionNpcId is passed through unchanged (the engine puts it in the inbox).
        this.noteFailure();
        return { kind: "empty", mentionNpcId: mention.npcId, partialText: emittedText };
      }
      // A turn that resolved normally but has no usable text at all counts as a failed turn
      // from the loop's perspective — nothing gets recorded in the transcript, so none of
      // maxTotalTurns, remainingTurns, or consecutivePasses advances.
      this.noteFailure();
      return { kind: "empty", mentionNpcId: null, partialText: emittedText };
    } catch (err) {
      this.noteFailure();
      return {
        kind: "error",
        error: err,
        partialText: emittedText,
        timedOut: timedOutKind ? { kind: timedOutKind } : null,
      };
    }
  }
}
