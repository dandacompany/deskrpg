import type { MeetingDiscussionState } from "../lib/meeting-discussion-state";
import { describeMeetingFailure } from "../lib/meeting-error";
import type { MeetingSpatialCoordinator } from "./meeting-spatial-coordinator";
import { MEETING_NPC_STREAM_EVENT } from "./meeting-socket";
import type { AdapterRegistry, NpcAdapter } from "../lib/adapters/types";
import {
  ConversationEngine,
  type EngineParticipant,
  type RunMode,
} from "../lib/conversation/conversation-engine";
import type { Turn } from "../lib/conversation/transcript";
import type {
  MeetingOutcome,
  MeetingSummaryStatus,
  OutcomeParticipant,
} from "../lib/meeting-outcome";
import {
  classifyNpcDispatch,
  createHermesAdapterForNpc,
  deriveHermesContextKey,
} from "./hermes-dispatch";

const { generateTranscript } =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("../lib/meeting-formatter.js") as typeof import("../lib/meeting-formatter.js");

// Meetings flow only through socket events and leave no HTTP logs. So when it gets into the state of "shows as
// started on screen but nobody speaks", there is not a single clue on the server side — diagnosing that state
// actually took two 5-minute e2e runs. Uses the same kind of switch as DEBUG_CHAT.
const DEBUG_MEETING = process.env.DEBUG_CHAT === "1" || process.env.DEBUG_MEETING === "1";
function meetingLog(...args: unknown[]) {
  if (DEBUG_MEETING) console.log("[meeting]", ...args);
}

type MeetingRoom = {
  participants: Set<string>;
  messages: MeetingMessage[];
};

type MeetingMessage = {
  id: string;
  sender: string;
  senderId: string;
  senderType: "user" | "npc";
  content: string;
  timestamp: number;
};

type MeetingPlayer = {
  characterName?: string | null;
};

type MeetingNpcConfig = {
  id: string;
  name: string;
  agentId: string | null;
  sessionKeyPrefix: string;
  /** Used for backend branch classification (classifyNpcDispatch). Real socket wiring always fills it in,
   * but this file's unit tests use minimal fixtures, so it is optional and guarded with a default. */
  adapterType?: string;
  hermesProfileId?: string | null;
  role?: string | null;
  passPolicy?: string | null;
  /** System instructions to put on this NPC's turn. Computed and filled in by getNpcConfig*. */
  instructions?: string | null;
};

type MeetingSocket = {
  id: string;
  on(event: string, handler: (payload: unknown) => unknown): void;
  emit(event: string, payload: unknown): void;
};

type MeetingIo = {
  to(room: string): {
    emit(event: string, payload: unknown): void;
  };
};

type MeetingUser = {
  userId: string;
  nickname?: string | null;
};

/** Result resolved once per participant at run() start and reused for the meeting — adapter instances
 * are not held here (a view for callbacks/lookup). The adapter itself exists only as an EngineParticipant
 * bound to one meeting. */
type MeetingBrokerParticipant = {
  npcId: string;
  displayName: string;
  role: string;
  passPolicy: string | null;
  /** Result of composeNpcInstructions(). Carried on both polls and speech. */
  instructions?: string | null;
};

type ExcludedMeetingNpc = {
  npcId: string;
  displayName: string;
  reason: "unbound" | "hermes_profile_unavailable" | "adapter_unavailable";
};

type MeetingBrokerConfig = {
  topic: string;
  npcs: MeetingNpcConfig[];
  userId: string;
  channelId: string;
  adapterRegistry: AdapterRegistry;
  sessionKeyPrefix: string;
  meetingId: string;
  settings: Record<string, unknown>;
  quota: {
    maxTotalTurns: number;
  };
  /** The meeting opener's language — turn prompts and minutes follow it. Omitted means Korean. */
  locale?: string | null;
};

/** `outcome`/`status` are optional — without them it is treated as a successful summary with no structured result. */
type MeetingSummary = {
  keyTopics: string[];
  conclusions: string | null;
  outcome?: MeetingOutcome | null;
  status?: MeetingSummaryStatus;
};

export type MeetingBrokerLike = {
  discussionState?: MeetingDiscussionState;
  config: {
    participants: MeetingBrokerParticipant[];
    sessionKeyPrefix?: string;
    meetingId?: string;
  };
  turns: unknown[];
  isRunning(): boolean;
  run(): Promise<void>;
  stop(): void;
  setMode(mode: string): void;
  nextTurn(): void;
  directSpeak(npcId: string): void;
  abortCurrentTurn(): void;
  addUserMessage(userName: string, content: string): void;
};

type MeetingBrokerCallbacks = {
  onPollStart?: () => void;
  onPollResult?: (
    raises: Array<{ agent: MeetingBrokerParticipant; reason: string }>,
    passes: string[],
    /** Participants the poll couldn't reach. Delivered separately from silence (passes). */
    failures: Array<{ agent: MeetingBrokerParticipant; reason: string }>,
  ) => void;
  onTurnStart?: (agent: MeetingBrokerParticipant) => void;
  onTurnChunk?: (npcId: string, chunk: string) => void;
  onTurnEnd?: (npcId: string, fullResponse: string) => void;
  onModeChanged?: (mode: string, by: string) => void;
  onWaitingInput?: (pollResult: unknown) => void;
  onTurnAborted?: (npcId: string) => void;
  onMeetingEnd?: (transcript: string, durationSeconds?: number) => void | Promise<void>;
  /** NPCs that were mentioned but skipped. Same family as onParticipantsExcluded. reason distinguishes quota exhaustion
   * ("quota_exhausted") from consecutive gateway failures ("backend_failing") — merging them would make
   * a dead gateway look like normal quota exhaustion. */
  onMentionSkipped?: (npcId: string, reason: "quota_exhausted" | "backend_failing") => void;
  onError?: (error: unknown) => void;
  /**
   * NPCs excluded from the participant list because their adapter couldn't be resolved. Announced, not silently
   * dropped (requirement).
   */
  onParticipantsExcluded?: (excluded: ExcludedMeetingNpc[]) => void;
};

type PersistMeetingMinutesInput = {
  channelId: string;
  topic: string;
  transcript: string;
  participants: Array<{ id: string; name: string; type: "npc" | "player"; agentId?: string }>;
  totalTurns: number;
  durationSeconds?: number;
  initiatorId: string | null;
  keyTopics: string[];
  conclusions: string | null;
  outcome?: MeetingOutcome | null;
  summaryStatus?: MeetingSummaryStatus;
};

type RegisterMeetingDiscussionHandlersArgs = {
  io: MeetingIo;
  socket: MeetingSocket;
  deps: {
    activeBrokers: Map<string, MeetingBrokerLike>;
    discussionInitiators: Map<string, string>;
    meetingRooms: Map<string, MeetingRoom>;
    players: Map<string, MeetingPlayer>;
    user: MeetingUser;
    adapterRegistry: AdapterRegistry;
    /** The socket's language cookie (null when absent). A meeting opened from this socket speaks it:
     * turn prompts, minutes and the summary. Omitted means Korean, as before locales existed. */
    locale?: string | null;
    getNpcConfigsForChannel: (channelId: string) => Promise<MeetingNpcConfig[]>;
    canControlMeeting: (channelId: string, userId: string) => Promise<boolean> | boolean;
    spatial?: MeetingSpatialCoordinator;
    /**
     * Announces to the office room when a meeting that produced follow-up work ends. Optional dependency —
     * no notice if not injected (meeting tests that run without socket/DB keep working). The implementation doesn't throw.
     */
    announceOutcome?: (input: {
      channelId: string;
      minutesId: string | null;
      topic: string;
      outcome: MeetingOutcome | null;
      summaryStatus: MeetingSummaryStatus;
    }) => Promise<void>;
    canStartMeeting?: (channelId: string, userId: string) => Promise<boolean> | boolean;
    createMeetingBroker?: (
      config: MeetingBrokerConfig,
      callbacks: MeetingBrokerCallbacks,
    ) => MeetingBrokerLike | Promise<MeetingBrokerLike>;
    /** Meeting summary. It used to be tied directly to the OpenClaw gateway's chatSend, so it only
     * ran in meetings with `gateway && openclawAgentId` — i.e. Hermes meetings always left an empty summary.
     * Now it takes the participant adapter as-is and runs regardless of backend. */
    generateMeetingSummary: (
      adapter: NpcAdapter,
      sessionKey: string,
      topic: string,
      transcript: string,
      /** Candidates to own follow-up work — only staff who attended the meeting. */
      participants?: OutcomeParticipant[],
      /** Language of the summary — the meeting opener's. */
      locale?: string | null,
    ) => Promise<MeetingSummary>;
    persistMeetingMinutes: (input: PersistMeetingMinutesInput) => Promise<string | null>;
  };
};

/** Validates by the same standard as setMode (conversation-engine.ts:setMode). Unknown values become "auto". */
function toRunMode(value: unknown): RunMode {
  return value === "auto" || value === "manual" || value === "directed" ? value : "auto";
}

function getMeetingRoomId(channelId: string) {
  return `meeting-${channelId}`;
}

/** Same shape as createHermesAdapterForNpc — null if the profile isn't found. */
type CreateHermesAdapter = (
  npcId: string,
  userId: string,
  contextKey: string,
) => Promise<NpcAdapter | null>;

export type ResolvedMeetingParticipant = {
  participant: MeetingBrokerParticipant;
  adapter: NpcAdapter;
  sessionKey: string;
};

/**
 * Resolves one NPC into a real backend adapter. To keep the P1b verdict (a HermesAdapter is created only once
 * per meeting and reused for that meeting — never registered as a singleton shared across meetings), this function is
 * called exactly once per participant at meeting start.
 */
/**
 * Meeting session scope. Hermes sessions are keyed as `<prefix>-<scope>`, so if this string
 * changes, that NPC's conversation context breaks. The literal is not scattered across call sites
 * because it actually drifted once — `-meeting-` went missing from the summary scope.
 */
export function meetingSessionScope(meetingId: string): string {
  return `meeting-${meetingId}`;
}

/**
 * Summarizer session scope. It **must differ** from the meeting scope — if they were equal, the summary prompt
 * would mix into that NPC's meeting context and pollute its speech in the next meeting.
 */
export function meetingSummarySessionScope(meetingId: string): string {
  return `${meetingSessionScope(meetingId)}-summary`;
}

export async function resolveNpcAdapter(
  npc: MeetingNpcConfig,
  ctx: {
    sessionScope: string;
    userId: string;
    adapterRegistry: AdapterRegistry;
    /** Injection point to observe the hermes branch in tests without DB/gateway. The default is the real wiring. */
    createHermesAdapter?: CreateHermesAdapter;
  },
): Promise<ResolvedMeetingParticipant | { excluded: ExcludedMeetingNpc }> {
  const adapterType = npc.adapterType || "hermes";
  const hermesProfileId = npc.hermesProfileId ?? null;
  const dispatchKind = classifyNpcDispatch({ adapterType, hermesProfileId });
  const sessionKeyBase = npc.sessionKeyPrefix || npc.id;
  const sessionKey = `${sessionKeyBase}-${ctx.sessionScope}`;

  const participantBase: MeetingBrokerParticipant = {
    npcId: npc.id,
    displayName: npc.name,
    role: npc.role || "Participant",
    passPolicy: npc.passPolicy || null,
    instructions: npc.instructions ?? null,
  };

  if (dispatchKind === "unbound") {
    return { excluded: { npcId: npc.id, displayName: npc.name, reason: "unbound" } };
  }

  if (dispatchKind === "hermes") {
    const contextKey = deriveHermesContextKey(sessionKey, sessionKeyBase);
    const createAdapter = ctx.createHermesAdapter ?? createHermesAdapterForNpc;
    const adapter = await createAdapter(npc.id, ctx.userId, contextKey);
    if (!adapter) {
      return {
        excluded: { npcId: npc.id, displayName: npc.name, reason: "hermes_profile_unavailable" },
      };
    }
    return { participant: participantBase, adapter, sessionKey };
  }

  if (dispatchKind === "openclaw") {
    // OpenClaw has been removed. Remaining openclaw NPCs, instead of silently dropping out of the meeting,
    // are excluded with a reason so the user can tell they need to reconnect.
    return { excluded: { npcId: npc.id, displayName: npc.name, reason: "unbound" } };
  }

  // dispatchKind === "registry"
  if (!ctx.adapterRegistry.has(adapterType)) {
    return { excluded: { npcId: npc.id, displayName: npc.name, reason: "adapter_unavailable" } };
  }
  return {
    participant: participantBase,
    adapter: ctx.adapterRegistry.get(adapterType),
    sessionKey,
  };
}

export async function defaultCreateMeetingBroker(
  config: MeetingBrokerConfig,
  callbacks: MeetingBrokerCallbacks,
  deps: { createHermesAdapter?: CreateHermesAdapter } = {},
): Promise<MeetingBrokerLike> {
  const resolved: ResolvedMeetingParticipant[] = [];
  const excluded: ExcludedMeetingNpc[] = [];

  for (const npc of config.npcs) {
    const result = await resolveNpcAdapter(npc, {
      sessionScope: meetingSessionScope(config.meetingId),
      userId: config.userId,
      adapterRegistry: config.adapterRegistry,
      createHermesAdapter: deps.createHermesAdapter,
    });
    if ("excluded" in result) {
      excluded.push(result.excluded);
    } else {
      resolved.push(result);
    }
  }

  if (excluded.length > 0) {
    callbacks.onParticipantsExcluded?.(excluded);
  }

  const participantByNpcId = new Map(resolved.map((r) => [r.participant.npcId, r.participant]));

  const engineParticipants: EngineParticipant[] = resolved.map(
    ({ participant, adapter, sessionKey }) => ({
      npcId: participant.npcId,
      displayName: participant.displayName,
      seated: true,
      turnCount: 0,
      lastSpokeAt: 0,
      adapter,
      sessionKey,
      role: participant.role,
      passPolicy: participant.passPolicy,
      instructions: participant.instructions ?? null,
    }),
  );

  let turns: Turn[] = [];
  const startedAt = Date.now();

  const engine = new ConversationEngine(
    {
      mode: "meeting",
      topic: config.topic,
      participants: engineParticipants,
      quota: {
        maxTurnsPerAgent: 20,
        maxTotalTurns: config.quota.maxTotalTurns,
        maxConsecutivePasses: 2,
        cooldownMs: 1000,
      },
      // Validate rather than cast — unlike setMode, the engine constructor doesn't check the value, so
      // an invalid value would behave like auto while meeting:mode-changed sends that invalid string
      // back to the client.
      initialRunMode: toRunMode(config.settings?.initialMode),
      hybridMode: Boolean(config.settings?.hybridMode),
      hybridAutoResumeMs: (config.settings?.hybridAutoResumeMs as number) ?? null,
      locale: config.locale,
    },
    {
      onPollStart: () => callbacks.onPollStart?.(),
      onPollResult: (raises, passes, failures) => {
        meetingLog(
          "폴링 결과: raises=",
          raises.map((r) => r.npcId).join(",") || "(없음)",
          "passes=",
          passes.join(",") || "(없음)",
          "failures=",
          (failures ?? []).map((f) => f.npcId).join(",") || "(없음)",
        );
        callbacks.onPollResult?.(
          raises
            .map((r) => {
              const agent = participantByNpcId.get(r.npcId);
              return agent ? { agent, reason: r.reason } : null;
            })
            .filter((r): r is { agent: MeetingBrokerParticipant; reason: string } => r !== null),
          passes,
          (failures ?? [])
            .map((f) => {
              const agent = participantByNpcId.get(f.npcId);
              return agent ? { agent, reason: f.reason } : null;
            })
            .filter((f): f is { agent: MeetingBrokerParticipant; reason: string } => f !== null),
        );
      },
      onTurnStart: (npcId) => {
        meetingLog("턴 시작:", npcId);
        const agent = participantByNpcId.get(npcId);
        if (agent) callbacks.onTurnStart?.(agent);
      },
      onTurnChunk: (npcId, chunk) => callbacks.onTurnChunk?.(npcId, chunk),
      onTurnEnd: (npcId, fullResponse) => callbacks.onTurnEnd?.(npcId, fullResponse),
      onModeChanged: (mode, source) => callbacks.onModeChanged?.(mode, source),
      onWaitingInput: (pollResult) => callbacks.onWaitingInput?.(pollResult),
      onMentionSkipped: (npcId, reason) => callbacks.onMentionSkipped?.(npcId, reason),
      onError: (err) => callbacks.onError?.(err),
      onEnd: (finalTurns) => {
        turns = finalTurns;
        const transcript = generateTranscript(
          config.topic,
          finalTurns,
          resolved.map(({ participant }) => ({
            displayName: participant.displayName,
            role: participant.role,
          })),
          config.locale,
        );
        const durationSeconds = Math.floor((Date.now() - startedAt) / 1000);
        void callbacks.onMeetingEnd?.(transcript, durationSeconds);
      },
    },
  );

  return {
    config: {
      participants: resolved.map((r) => r.participant),
      sessionKeyPrefix: config.sessionKeyPrefix,
      meetingId: config.meetingId,
    },
    get turns() {
      return turns;
    },
    isRunning: () => engine.isRunning(),
    run: () => engine.run(),
    stop: () => engine.stop(),
    setMode: (mode) => engine.setMode(mode),
    nextTurn: () => engine.nextTurn(),
    directSpeak: (npcId) => engine.directSpeak(npcId),
    abortCurrentTurn: () => engine.abortCurrentTurn(),
    addUserMessage: (userName, content) => engine.addUserMessage(userName, content),
  };
}

/**
 * Settlement called by every path that ends a meeting — broker cleanup and staff return happen in one place.
 * Previously each path wrote it separately, and only the path where the host leaves and the room empties
 * (socket-handlers' disconnect)
 * missed the return, leaving staff in meeting seats. On top of that, the spatial session stayed at "ready",
 * so spatial.start returned null and the channel's next meeting silently failed to start.
 */
export function settleMeeting(
  state: {
    activeBrokers: Map<string, MeetingBrokerLike>;
    discussionInitiators: Map<string, string>;
    spatial?: Pick<MeetingSpatialCoordinator, "cancel">;
  },
  channelId: string,
  opts: { stopBroker?: boolean; context: string },
): void {
  if (opts.stopBroker) state.activeBrokers.get(channelId)?.stop();
  state.activeBrokers.delete(channelId);
  state.discussionInitiators.delete(channelId);
  void state.spatial?.cancel(channelId).catch((error) => {
    console.error(`[meeting] ${opts.context} 후 복귀 정산 실패`, { channelId }, error);
  });
}

export function registerMeetingDiscussionHandlers({
  io,
  socket,
  deps,
}: RegisterMeetingDiscussionHandlersArgs) {
  const {
    activeBrokers,
    discussionInitiators,
    meetingRooms,
    players,
    user,
    adapterRegistry,
    getNpcConfigsForChannel,
    canControlMeeting,
    createMeetingBroker = defaultCreateMeetingBroker,
    generateMeetingSummary,
    persistMeetingMinutes,
  } = deps;

  socket.on("meeting:start-discussion", async (payload: unknown) => {
    const { channelId, topic, settings, selectedNpcIds } = (payload ?? {}) as {
      channelId?: string;
      topic?: string;
      settings?: Record<string, unknown> & { maxTotalTurns?: number; initialMode?: string };
      selectedNpcIds?: string[];
    };

    meetingLog("start-discussion 수신:", { channelId, topic: topic?.slice(0, 40), selectedNpcIds });
    if (typeof channelId !== "string" || typeof topic !== "string" || !topic.trim()) return;
    if (
      selectedNpcIds !== undefined &&
      (!Array.isArray(selectedNpcIds) || selectedNpcIds.some((id) => typeof id !== "string"))
    ) {
      socket.emit("meeting:error", { error: "invalid_participants" });
      return;
    }
    if (deps.canStartMeeting && !(await deps.canStartMeeting(channelId, user.userId))) {
      socket.emit("meeting:error", { error: "Permission denied" });
      return;
    }
    if (activeBrokers.has(channelId)) {
      socket.emit("meeting:error", { error: "A meeting is already in progress" });
      return;
    }

    // This used to unconditionally await getOrConnectGateway(channelId) here. The comment
    // said "only needed when resolving openclaw participants", but the code always called it, and when a Hermes
    // gateway returned 403 to the OpenClaw WS handshake it hung right there —
    // the screen showed only "토론이 시작되었습니다" while the first turn was never dispatched.
    // Now that OpenClaw is gone, there is no gateway to acquire at all.

    const npcConfigs = await getNpcConfigsForChannel(channelId);
    let candidateNpcs = npcConfigs;

    if (selectedNpcIds && selectedNpcIds.length > 0) {
      const selectedSet = new Set(selectedNpcIds);
      candidateNpcs = candidateNpcs.filter((npc) => selectedSet.has(npc.id));
    }
    let spatialGeneration: number | null = null;
    if (deps.spatial) {
      spatialGeneration = await deps.spatial.start(
        channelId,
        user.userId,
        selectedNpcIds?.length ? selectedNpcIds : candidateNpcs.map((n) => n.id),
      );
      if (spatialGeneration === null) return;
      discussionInitiators.set(channelId, user.userId);
      const missing = selectedNpcIds?.find((id) => !npcConfigs.some((n) => n.id === id));
      if (missing) deps.spatial.block(channelId, missing, "actor_unavailable", spatialGeneration);
      if (!(await deps.spatial.ready(channelId, spatialGeneration))) return;
      if (deps.canStartMeeting && !(await deps.canStartMeeting(channelId, user.userId))) {
        deps.spatial.block(channelId, user.userId, "participant_left", spatialGeneration);
        return;
      }
    }

    meetingLog(
      "후보 NPC:",
      candidateNpcs.map((n) => `${n.name}(${n.adapterType})`).join(", ") || "(없음)",
    );
    if (candidateNpcs.length === 0) {
      socket.emit("meeting:error", { error: "No AI NPCs in this channel" });
      return;
    }

    const meetingParticipants: Array<{
      id: string;
      name: string;
      type: "npc" | "player";
      agentId?: string;
    }> = [
      ...candidateNpcs.map((npc) => ({
        id: npc.id,
        name: npc.name,
        type: "npc" as const,
        agentId: npc.agentId || undefined,
      })),
    ];

    const room = meetingRooms.get(channelId);
    if (room) {
      for (const participantId of room.participants) {
        const player = players.get(participantId);
        if (!player) continue;
        meetingParticipants.push({
          id: participantId,
          name: player.characterName || "Unknown",
          type: "player",
        });
      }
    }

    const meetingId = `meet-${Date.now()}`;
    // Captured once at start: the whole meeting keeps the opener's language.
    const meetingLocale = deps.locale;
    const sessionKeyPrefix = candidateNpcs[0].sessionKeyPrefix || channelId.slice(0, 8);

    // The summary adapter is resolved once, **separately** from meeting participants. The broker's config.participants
    // is a lookup view that holds no adapters (see the type comment above), so it can't be reached from outside,
    // and the summary session has to be separate from the meeting session anyway — if the summary prompt mixed into
    // that NPC's meeting context, its speech in the next meeting would be polluted.
    const summarizerResolution = await resolveNpcAdapter(candidateNpcs[0], {
      sessionScope: meetingSummarySessionScope(meetingId),
      userId: user.userId,
      adapterRegistry,
    });
    const summarizerAdapter =
      "adapter" in summarizerResolution ? summarizerResolution.adapter : null;

    const brokerInstance = await createMeetingBroker(
      {
        topic,
        npcs: candidateNpcs,
        userId: user.userId,
        channelId,
        adapterRegistry,
        sessionKeyPrefix,
        meetingId,
        settings: settings || {},
        quota: {
          maxTotalTurns: settings?.maxTotalTurns || 50,
        },
        locale: meetingLocale,
      },
      {
        onPollStart: () => {
          if (brokerInstance.discussionState) brokerInstance.discussionState.isWaitingInput = false;
          io.to(getMeetingRoomId(channelId)).emit("meeting:poll-status", { status: "polling" });
        },
        onPollResult: (raises, passes, failures) => {
          io.to(getMeetingRoomId(channelId)).emit("meeting:poll-status", {
            raises: raises.map((raise) => ({
              name: raise.agent.displayName,
              reason: raise.reason,
            })),
            passes,
            // Send unreachable participants distinguished from silence — so the screen doesn't flatten it
            // into "all PASS".
            failures: (failures ?? []).map((failure) => ({
              name: failure.agent.displayName,
              reason: failure.reason,
            })),
          });
        },
        onTurnStart: (agent) => {
          const state = brokerInstance.discussionState;
          if (state) {
            state.isWaitingInput = false;
            state.currentSpeaker = { npcId: agent.npcId, npcName: agent.displayName };
            state.rawStreams = {};
          }
          io.to(getMeetingRoomId(channelId)).emit("meeting:npc-turn-start", {
            npcId: agent.npcId,
            npcName: agent.displayName,
          });
        },
        onTurnChunk: (npcId, chunk) => {
          const state = brokerInstance.discussionState;
          if (state) {
            state.rawStreams ??= {};
            state.rawStreams[npcId] = (state.rawStreams[npcId] || "") + chunk;
          }
          io.to(getMeetingRoomId(channelId)).emit(MEETING_NPC_STREAM_EVENT, {
            npcId,
            chunk,
            done: false,
          });
        },
        onTurnEnd: (npcId, fullResponse) => {
          const state = brokerInstance.discussionState;
          if (state) {
            state.currentSpeaker = null;
            delete state.rawStreams?.[npcId];
          }
          const agent = brokerInstance.config.participants.find(
            (participant) => participant.npcId === npcId,
          );
          io.to(getMeetingRoomId(channelId)).emit(MEETING_NPC_STREAM_EVENT, {
            npcId,
            npcName: agent?.displayName || npcId,
            chunk: "",
            done: true,
            // The screen finalizes the speech bubble with this. The accumulated deltas may include earlier
            // retried generations, so finalizing them as-is would diverge from the body recorded in the meeting log below.
            text: fullResponse,
          });

          const liveRoom = meetingRooms.get(channelId);
          if (!liveRoom) return;
          // An aborted turn may not even have partial text — close the bubble above, but don't record an empty message
          // in the meeting log.
          if (!fullResponse) return;

          liveRoom.messages.push({
            id: `msg-${Date.now()}-${npcId}`,
            sender: agent?.displayName || npcId,
            senderId: `npc-${npcId}`,
            senderType: "npc",
            content: fullResponse,
            timestamp: Date.now(),
          });
          if (liveRoom.messages.length > 100) {
            liveRoom.messages.splice(0, liveRoom.messages.length - 100);
          }
        },
        onModeChanged: (mode, by) => {
          if (
            brokerInstance.discussionState &&
            (mode === "auto" || mode === "manual" || mode === "directed")
          )
            brokerInstance.discussionState.mode = mode;
          const state = brokerInstance.discussionState;
          // A mode change releases the engine wait; the next waiting callback re-arms it.
          if (state) state.isWaitingInput = false;
          io.to(getMeetingRoomId(channelId)).emit("meeting:mode-changed", {
            mode,
            by,
            execution: state
              ? {
                  isWaitingInput: state.isWaitingInput,
                  currentSpeaker: state.currentSpeaker,
                  rawStreams: { ...state.rawStreams },
                }
              : undefined,
          });
        },
        onWaitingInput: (pollResult) => {
          if (brokerInstance.discussionState) brokerInstance.discussionState.isWaitingInput = true;
          io.to(getMeetingRoomId(channelId)).emit("meeting:waiting-input", { pollResult });
        },
        onTurnAborted: (npcId) => {
          const state = brokerInstance.discussionState;
          if (state) {
            state.currentSpeaker = null;
            delete state.rawStreams?.[npcId];
          }
          io.to(getMeetingRoomId(channelId)).emit("meeting:turn-aborted", { npcId });
        },
        onParticipantsExcluded: (excluded) => {
          meetingLog("제외:", excluded.map((e) => `${e.displayName}=${e.reason}`).join(", "));
          const names = excluded.map((e) => e.displayName).join(", ");
          io.to(getMeetingRoomId(channelId)).emit("meeting:error", {
            error: `Excluded from the meeting (no usable backend): ${names}`,
          });
        },
        onMentionSkipped: (npcId, reason) => {
          const agent = brokerInstance.config.participants.find(
            (participant) => participant.npcId === npcId,
          );
          meetingLog("지목 건너뜀:", `${agent?.displayName || npcId}=${reason}`);
          // Display text is not built here — only npcId/reason are passed and the client
          // renders it via i18n (meeting.mentionSkipped.*).
          io.to(getMeetingRoomId(channelId)).emit("meeting:mention-skipped", {
            npcId,
            npcName: agent?.displayName || npcId,
            reason,
          });
        },
        onMeetingEnd: async (transcript, durationSeconds) => {
          if (activeBrokers.get(channelId) !== brokerInstance) return;
          // No staff to summarize is not a failure but a skip — retrying gives the same result.
          let summary: MeetingSummary = {
            keyTopics: [],
            conclusions: null,
            outcome: null,
            status: "skipped",
          };
          // Have any one participant do the summary. The summary session key is separated from the meeting session so
          // the summary prompt doesn't mix into that NPC's meeting context.
          if (summarizerAdapter) {
            const summaryKey = `${brokerInstance.config.sessionKeyPrefix || sessionKeyPrefix}-summary-${
              brokerInstance.config.meetingId || meetingId
            }`;
            summary = await generateMeetingSummary(
              summarizerAdapter,
              summaryKey,
              topic,
              transcript,
              meetingParticipants
                .filter((participant) => participant.type === "npc")
                .map((participant) => ({ npcId: participant.id, name: participant.name })),
              meetingLocale,
            );
          }

          if (activeBrokers.get(channelId) !== brokerInstance) return;
          const minutesId = await persistMeetingMinutes({
            channelId,
            topic,
            transcript,
            participants: meetingParticipants,
            totalTurns: brokerInstance.turns.length,
            durationSeconds,
            initiatorId: discussionInitiators.get(channelId) || null,
            keyTopics: summary.keyTopics,
            conclusions: summary.conclusions,
            outcome: summary.outcome ?? null,
            summaryStatus: summary.status ?? "ok",
          });

          if (activeBrokers.get(channelId) !== brokerInstance) return;
          io.to(getMeetingRoomId(channelId)).emit("meeting:end", {
            transcript,
            keyTopics: summary.keyTopics,
            conclusions: summary.conclusions,
            outcome: summary.outcome ?? null,
            summaryStatus: summary.status ?? "ok",
            minutesId,
            discussion: brokerInstance.discussionState,
            participantCount: meetingParticipants.length,
            totalTurns: brokerInstance.turns.length,
            durationSeconds,
          });

          // Leave it in the office room so people outside the meeting room know too. The implementation checks the
          // conditions (follow-up work exists, summary succeeded).
          void deps.announceOutcome?.({
            channelId,
            minutesId,
            topic,
            outcome: summary.outcome ?? null,
            summaryStatus: summary.status ?? "ok",
          });

          settleMeeting(deps, channelId, { context: "회의 종료" });
        },
        onError: (error) => {
          // Carrying the adapter's thrown value (HermesError etc.) as-is makes the screen draw [object Object].
          const failure = describeMeetingFailure(error);
          console.warn("[meeting] NPC 응답 실패", { channelId, code: failure.error }, error);
          io.to(getMeetingRoomId(channelId)).emit("meeting:error", failure);
        },
      },
    );

    // If no NPC able to participate remains after adapter resolution (all unbound/unresolved), don't silently start
    // and immediately end an empty meeting; end it as a failure, same as the pre-start check. Exclusion reasons were
    // already announced individually by onParticipantsExcluded — this is a separate final signal that "so the meeting
    // itself did not start".
    if (brokerInstance.config.participants.length === 0) {
      if (deps.spatial && spatialGeneration !== null)
        deps.spatial.block(
          channelId,
          candidateNpcs[0]?.id ?? user.userId,
          "backend_unavailable",
          spatialGeneration,
        );
      socket.emit("meeting:error", { error: "No AI NPCs in this channel" });
      return;
    }
    if (deps.spatial && spatialGeneration !== null) {
      const excluded = candidateNpcs.find(
        (n) => !brokerInstance.config.participants.some((p) => p.npcId === n.id),
      );
      if (excluded) {
        deps.spatial.block(channelId, excluded.id, "backend_unavailable", spatialGeneration);
        return;
      }
      if (
        deps.spatial.snapshot(channelId)?.generation !== spatialGeneration ||
        deps.spatial.snapshot(channelId)?.phase !== "ready"
      )
        return;
    }

    meetingLog(
      "브로커 시작:",
      brokerInstance.config.participants.map((p) => p.displayName).join(", "),
    );
    brokerInstance.discussionState = {
      topic,
      npcs: brokerInstance.config.participants.map((npc) => ({
        id: npc.npcId,
        name: npc.displayName,
      })),
      mode: settings?.initialMode === "manual" ? "manual" : "auto",
      initiatorId: user.userId,
      initiatorSocketId: socket.id,
      isWaitingInput: false,
      currentSpeaker: null,
      rawStreams: {},
    };
    if (room) room.messages = [];
    activeBrokers.set(channelId, brokerInstance);
    discussionInitiators.set(channelId, user.userId);

    brokerInstance.run().catch((error) => {
      if (activeBrokers.get(channelId) !== brokerInstance) return;
      console.error("[meeting] Broker error:", error);
      settleMeeting(deps, channelId, { context: "오류 종료" });
      io.to(getMeetingRoomId(channelId)).emit("meeting:error", {
        error: "Meeting ended due to error",
      });
    });

    io.to(getMeetingRoomId(channelId)).emit("meeting:mode-changed", {
      mode: settings?.initialMode || "auto",
      by: user.userId,
      initiatorId: user.userId,
      discussion: brokerInstance.discussionState,
    });
  });

  socket.on("meeting:user-speak", (payload: unknown) => {
    const { channelId, message } = (payload ?? {}) as { channelId?: string; message?: string };
    if (!channelId || !message) return;

    const broker = activeBrokers.get(channelId);
    if (!broker || !broker.isRunning()) return;

    const player = players.get(socket.id);
    const userName = player?.characterName || user.nickname || "Unknown";
    const trimmed = String(message).trim().slice(0, 500);
    if (!trimmed) return;

    broker.addUserMessage(userName, trimmed);

    const room = meetingRooms.get(channelId);
    const userMessage: MeetingMessage = {
      id: `msg-${Date.now()}-user`,
      sender: userName,
      senderId: socket.id,
      senderType: "user",
      content: trimmed,
      timestamp: Date.now(),
    };

    if (room) {
      room.messages.push(userMessage);
      if (room.messages.length > 100) {
        room.messages.splice(0, room.messages.length - 100);
      }
    }

    io.to(getMeetingRoomId(channelId)).emit("meeting:message", userMessage);
  });

  socket.on("meeting:stop", async (payload: unknown) => {
    const { channelId } = (payload ?? {}) as { channelId?: string };
    if (!channelId) return;
    if (!(await canControlMeeting(channelId, user.userId))) {
      socket.emit("meeting:error", { error: "Permission denied" });
      return;
    }
    await deps.spatial?.cancel(channelId);

    const broker = activeBrokers.get(channelId);
    if (!broker) return;

    broker.stop();
    discussionInitiators.delete(channelId);
  });

  socket.on("meeting:cancel-preparation", async (payload: unknown) => {
    const { channelId } = (payload ?? {}) as { channelId?: string };
    if (!channelId || !(await canControlMeeting(channelId, user.userId))) return;
    if (activeBrokers.has(channelId)) return;
    await deps.spatial?.cancel(channelId);
  });

  socket.on("meeting:set-mode", async (payload: unknown) => {
    const { channelId, mode } = (payload ?? {}) as { channelId?: string; mode?: string };
    if (!channelId || !mode) return;

    if (!(await canControlMeeting(channelId, user.userId))) {
      socket.emit("meeting:error", { error: "Permission denied" });
      return;
    }

    if (!["auto", "manual", "directed"].includes(mode)) {
      socket.emit("meeting:error", { error: "Invalid mode" });
      return;
    }

    const broker = activeBrokers.get(channelId);
    if (!broker || !broker.isRunning()) return;
    broker.setMode(mode);
  });

  socket.on("meeting:next-turn", async (payload: unknown) => {
    const { channelId } = (payload ?? {}) as { channelId?: string };
    if (!channelId) return;

    if (!(await canControlMeeting(channelId, user.userId))) {
      socket.emit("meeting:error", { error: "Permission denied" });
      return;
    }

    const broker = activeBrokers.get(channelId);
    if (!broker || !broker.isRunning()) return;
    const state = broker.discussionState;
    if (state?.mode !== "manual" || state.isWaitingInput !== true) return;
    // Consume readiness before calling the engine so repeated requests cannot queue a release.
    state.isWaitingInput = false;
    broker.nextTurn();
  });

  socket.on("meeting:direct-speak", async (payload: unknown) => {
    const { channelId, npcId } = (payload ?? {}) as { channelId?: string; npcId?: string };
    if (!channelId || !npcId) return;

    if (!(await canControlMeeting(channelId, user.userId))) {
      socket.emit("meeting:error", { error: "Permission denied" });
      return;
    }

    const broker = activeBrokers.get(channelId);
    if (!broker || !broker.isRunning()) return;

    const agent = broker.config.participants.find((participant) => participant.npcId === npcId);
    if (!agent) {
      socket.emit("meeting:error", { error: "NPC not found or has no agent" });
      return;
    }

    broker.directSpeak(npcId);
  });

  socket.on("meeting:abort-turn", async (payload: unknown) => {
    const { channelId } = (payload ?? {}) as { channelId?: string };
    if (!channelId) return;

    if (!(await canControlMeeting(channelId, user.userId))) {
      socket.emit("meeting:error", { error: "Permission denied" });
      return;
    }

    const broker = activeBrokers.get(channelId);
    if (!broker || !broker.isRunning()) return;
    broker.abortCurrentTurn();
  });
}
