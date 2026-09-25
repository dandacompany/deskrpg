import { withStreamDiagnosticRequest } from "@/lib/hermes/stream-diagnostics";
import { gatewayFailureMessageCode } from "@/lib/hermes/classify-gateway-failure";
// In map chat, the NPCs that were called respond at the same time. There's no loop — it only
// wakes up when a human's message arrives.
//
// Split from the meeting (ChannelRuntime) because: a meeting runs on a "who's next" beat
// decided every round, but free chat has no such beat. Fitting a round loop to event-driven
// behavior would mean constantly spinning on an empty beat. What's shared is
// NpcRuntime.speakWithPrompt — the machine that takes a prompt, makes it speak, and gets the
// response back.

import { randomUUID } from "node:crypto";
import { SessionQueue } from "./request-queue";
import { NpcRuntime } from "./npc-runtime";
import { Transcript } from "./transcript";
import { extractMentionNames, parseAllMentions } from "./mention";
import { ChatQuota, DEFAULT_CHAT_BUDGET } from "./chat-quota";
import { formatOpenChatMessage, type ChatLine } from "@/lib/open-chat-formatter";
import type { EngineParticipant } from "./types";
import type { UserContext } from "@/lib/user-context";

/** speakWithPrompt never reads these two. Set to conspicuous values so a test would reveal it if it ever did. */
const UNUSED_TOPIC = "__open_chat_topic_should_never_be_read__";
const UNUSED_MAX_TURNS = -1;

export type TurnContext = {
  requestId: string;
  sourceMessageId: string;
  callerSocketId: string | null;
  /**
   * The caller's name/intro, but only for a turn a human called directly. Null for a turn
   * where an NPC called another NPC — that turn's "caller" is a fellow NPC, so attaching a
   * human's intro would misidentify who's speaking.
   */
  callerContext?: UserContext | null;
  /**
   * Language of the human who started this chain. Unlike `callerContext` it is kept on chained turns — the
   * whole exchange answers that person. `undefined` keeps the original Korean script; `null` (no language
   * cookie) gets English.
   */
  callerLocale?: string | null;
  /**
   * The user id of the human who started this chain — kept on chained turns like `callerLocale`. A tool approval
   * an NPC asks for during the turn goes to this person. null when no human is known.
   */
  callerUserId?: string | null;
};

export type OpenChatCallbacks = {
  onTurnQueued?: (npcId: string, displayName: string, context: TurnContext) => void;
  onDisposed?: () => void;
  onQueueFull?: (npcId: string, sourceMessageId: string) => void;
  /**
   * A turn opened. `callerSocketId` is **the socket id of the person who started this
   * chain** — since it decides who the NPC walks over to, a turn where an NPC called another
   * NPC uses that same value too.
   */
  onTurnStart?: (
    npcId: string,
    displayName: string,
    callerSocketId: string | null,
    context: TurnContext,
  ) => void;
  onTurnChunk?: (npcId: string, chunk: string, context: TurnContext) => void;
  onTurnEnd?: (
    npcId: string,
    fullResponse: string,
    meta: { aborted: true; reason: string } | undefined,
    context: TurnContext,
  ) => unknown;
  /** An NPC that was mentioned but skipped because the gateway is down. Paired with the meeting's same-named callback. */
  onMentionSkipped?: (npcId: string, reason: "backend_failing") => void;
  /**
   * A human mentioned someone, but that mention produced not a single responder
   * (non-member, typo). There's no speech bubble on the map, so as-is this would be total
   * silence — this signals only the caller.
   */
  onMentionNoMatch?: (callerSocketId: string | null) => void;
  onError?: (err: unknown, npcId: string) => void;
  /** A turn was stopped by `cancelTurn` — it ends here, with no reply persisted and no chain. */
  onTurnCancelled?: (npcId: string, context: TurnContext) => void;
};

export type OpenChatDeps = {
  participants: EngineParticipant[];
  /** The recent conversation to include in the prompt. Passed through as-is from the socket layer's channel history. */
  recent: () => ChatLine[];
  recentForSource?: (sourceMessageId: string) => ChatLine[];
  turnTimeout: { idleMs: number; maxMs: number };
  historyLimit?: number;
  budget?: number;
  now?: () => number;
  /** The room's policy. If absent, mentions only — same as the whole-office room. */
  selectResponders?: (mentionedIds: string[]) => string[];
};

export class OpenChatRuntime {
  private readonly deps: OpenChatDeps;
  private readonly callbacks: OpenChatCallbacks;
  private readonly runtimes = new Map<string, NpcRuntime>();
  private readonly quota: ChatQuota;
  private readonly queue = new SessionQueue(8);
  /** requestId → npcId of every turn queued or running. */
  private readonly turns = new Map<string, string>();
  /** npcId → requestId of the turn it is speaking now. */
  private readonly speaking = new Map<string, string>();
  private readonly cancelled = new Set<string>();
  private disposed = false;

  constructor(deps: OpenChatDeps, callbacks: OpenChatCallbacks) {
    this.deps = deps;
    this.callbacks = callbacks;
    this.quota = new ChatQuota(deps.budget ?? DEFAULT_CHAT_BUDGET);

    const transcript = new Transcript();
    const now = deps.now ?? (() => Date.now());
    for (const participant of deps.participants) {
      this.runtimes.set(
        participant.npcId,
        new NpcRuntime(participant, {
          transcript,
          topic: UNUSED_TOPIC,
          allParticipants: deps.participants,
          maxTotalTurns: UNUSED_MAX_TURNS,
          historyLimit: deps.historyLimit ?? 10,
          turnTimeout: deps.turnTimeout,
          now,
        }),
      );
    }
  }

  isSpeaking(npcId: string): boolean {
    return this.queue.size(npcId) > 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.callbacks.onDisposed?.();
    for (const [id, runtime] of this.runtimes) if (this.isSpeaking(id)) runtime.abort();
  }

  /**
   * Stops one turn. A queued turn is dropped when its slot comes up; a running one has its
   * adapter aborted (which stops the Hermes run). Either way it ends with `onTurnCancelled`:
   * nothing is persisted and nothing chains. False when the turn already finished.
   */
  cancelTurn(requestId: string): boolean {
    const npcId = this.turns.get(requestId);
    if (!npcId || this.cancelled.has(requestId)) return false;
    this.cancelled.add(requestId);
    if (this.speaking.get(npcId) === requestId) this.runtimes.get(npcId)?.abort();
    return true;
  }

  async handleHumanMessage(
    senderName: string,
    text: string,
    callerSocketId: string | null = null,
    sourceMessageId: string = randomUUID(),
    callerContext: UserContext | null = null,
    callerLocale?: string | null,
    callerUserId: string | null = null,
  ): Promise<void> {
    if (this.disposed) return;
    this.quota.resetByHuman();
    const mentioned = parseAllMentions(text, this.participantsView(), null);
    const targets = this.deps.selectResponders ? this.deps.selectResponders(mentioned) : mentioned;
    if (targets.length === 0 && extractMentionNames(text).length > 0) {
      this.callbacks.onMentionNoMatch?.(callerSocketId);
    }
    const recent = (this.deps.recentForSource?.(sourceMessageId) ?? this.deps.recent()).map(
      (line) => ({ ...line }),
    );
    await this.dispatch(
      targets,
      senderName,
      true,
      callerSocketId,
      sourceMessageId,
      recent,
      callerContext,
      callerLocale,
      callerUserId,
    );
  }

  private participantsView(): Array<{ npcId: string; displayName: string }> {
    return this.deps.participants.map((p) => ({ npcId: p.npcId, displayName: p.displayName }));
  }

  private async dispatch(
    targets: string[],
    calledBy: string,
    fromHuman: boolean,
    callerSocketId: string | null,
    sourceMessageId: string,
    recent: ChatLine[],
    callerContext: UserContext | null = null,
    callerLocale?: string | null,
    callerUserId: string | null = null,
  ): Promise<void> {
    if (this.disposed) return;
    const work: Promise<void>[] = [];
    for (const npcId of new Set(targets)) {
      const runtime = this.runtimes.get(npcId);
      if (!runtime || (!fromHuman && this.isSpeaking(npcId))) continue;
      if (runtime.isBurnedOut()) {
        this.callbacks.onMentionSkipped?.(npcId, "backend_failing");
        continue;
      }
      if (this.queue.isFull(npcId)) {
        this.callbacks.onQueueFull?.(npcId, sourceMessageId);
        continue;
      }
      if (!fromHuman && !this.quota.spend()) break;
      const context: TurnContext = {
        requestId: randomUUID(),
        sourceMessageId,
        callerSocketId,
        callerContext: fromHuman ? callerContext : null,
        callerLocale,
        callerUserId,
      };
      this.callbacks.onTurnQueued?.(npcId, runtime.displayName, context);
      this.turns.set(context.requestId, npcId);
      // The chain runs after this job releases its queue slot, avoiding A -> B -> A deadlocks.
      const job = this.queue.run(npcId, () => this.speakOne(npcId, calledBy, context, recent));
      work.push(
        job.then(async (result) => {
          if (!result || this.disposed) return;
          const next = parseAllMentions(result.text, this.participantsView(), npcId);
          if (next.length)
            await this.dispatch(
              next,
              runtime.displayName,
              false,
              callerSocketId,
              result.messageId ?? sourceMessageId,
              this.deps.recent().map((line) => ({ ...line })),
              null,
              callerLocale,
              callerUserId,
            );
        }),
      );
    }
    await Promise.all(work);
  }

  private async speakOne(
    npcId: string,
    calledBy: string,
    context: TurnContext,
    recent: ChatLine[],
  ): Promise<{ text: string; messageId?: string } | undefined> {
    const runtime = this.runtimes.get(npcId);
    try {
      if (!runtime || this.disposed) return;
      if (this.cancelled.has(context.requestId)) {
        this.callbacks.onTurnCancelled?.(npcId, context);
        return;
      }
      this.speaking.set(npcId, context.requestId);
      return await this.speakTurn(npcId, runtime, calledBy, context, recent);
    } finally {
      this.turns.delete(context.requestId);
      this.cancelled.delete(context.requestId);
      if (this.speaking.get(npcId) === context.requestId) this.speaking.delete(npcId);
    }
  }

  private async speakTurn(
    npcId: string,
    runtime: NpcRuntime,
    calledBy: string,
    context: TurnContext,
    recent: ChatLine[],
  ): Promise<{ text: string; messageId?: string } | undefined> {
    const stopped = () => this.cancelled.has(context.requestId);
    let closed = false;
    try {
      this.callbacks.onTurnStart?.(npcId, runtime.displayName, context.callerSocketId, context);
      const others = this.deps.participants
        .filter((p) => p.npcId !== npcId)
        .map((p) => ({ displayName: p.displayName, role: p.role ?? "" }));
      const prompt = formatOpenChatMessage(
        { displayName: runtime.displayName },
        others,
        recent,
        calledBy,
        context.callerContext,
        context.callerLocale,
      );
      const outcome = await withStreamDiagnosticRequest(context.requestId, () =>
        runtime.speakWithPrompt(prompt, {
          onChunk: (chunk) => {
            if (!this.disposed && !closed && !stopped())
              this.callbacks.onTurnChunk?.(npcId, chunk, context);
          },
        }),
      );
      closed = true;
      if (this.disposed) return;
      if (stopped()) {
        this.callbacks.onTurnCancelled?.(npcId, context);
        return;
      }
      if (outcome.kind === "spoke") {
        const messageId = await this.callbacks.onTurnEnd?.(npcId, outcome.text, undefined, context);
        return {
          text: outcome.text,
          messageId: typeof messageId === "string" ? messageId : undefined,
        };
      }
      if (outcome.kind === "error") this.callbacks.onError?.(outcome.error, npcId);
      await this.callbacks.onTurnEnd?.(
        npcId,
        outcome.partialText,
        {
          aborted: true,
          reason:
            outcome.kind === "empty"
              ? "empty_response"
              : outcome.timedOut
                ? `timeout:${outcome.timedOut.kind}`
                : // The same cause a DM shows (an expired provider sign-in, a limit…); the
                  // adapter's own text stays with onError, which only logs it.
                  gatewayFailureMessageCode(outcome.error),
        },
        context,
      );
    } catch (error) {
      closed = true;
      if (stopped()) {
        this.callbacks.onTurnCancelled?.(npcId, context);
        return;
      }
      await this.callbacks.onTurnEnd?.(
        npcId,
        "",
        { aborted: true, reason: "adapter_error" },
        context,
      );
      throw error;
    }
  }
}
