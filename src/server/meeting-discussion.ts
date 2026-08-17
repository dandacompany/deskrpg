import { MEETING_NPC_STREAM_EVENT } from "./meeting-socket";
import { OpenClawAdapter } from "../lib/adapters/openclaw-adapter.js";
import type { AdapterRegistry, NpcAdapter } from "../lib/adapters/types";
import { ConversationEngine, type EngineParticipant, type RunMode } from "../lib/conversation/conversation-engine";
import type { Turn } from "../lib/conversation/transcript";
import {
  classifyNpcDispatch,
  createHermesAdapterForNpc,
  deriveHermesContextKey,
} from "./hermes-dispatch";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { generateTranscript } = require("../lib/meeting-formatter.js") as typeof import("../lib/meeting-formatter.js");

const openclawAdapter = new OpenClawAdapter();

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
  /** 백엔드 갈래 판정에 쓴다(classifyNpcDispatch). 실 소켓 배선은 항상 채워 보내지만,
   * 이 파일의 단위 테스트가 최소 픽스처를 쓰므로 optional로 두고 기본값으로 방어한다. */
  adapterType?: string;
  hermesProfileId?: string | null;
  role?: string | null;
  passPolicy?: string | null;
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

/** run() 시작 시 참가자별로 한 번 해석해 회의 동안 재사용하는 결과 — 어댑터 인스턴스는
 * 여기 담기지 않는다(콜백/조회용 뷰). 어댑터 자체는 회의 하나에 묶인 EngineParticipant로만 존재한다. */
type MeetingBrokerParticipant = {
  npcId: string;
  displayName: string;
  role: string;
  passPolicy: string | null;
  /** OpenClaw 실제 agentId. 회의 요약 생성(gateway.chatSend) 등 openclaw 전용 후속 작업에만 쓴다.
   * npcId(참가자 식별자)와는 별개다 — 혼동하지 말 것. */
  openclawAgentId: string | null;
};

type ExcludedMeetingNpc = {
  npcId: string;
  displayName: string;
  reason: "unbound" | "hermes_profile_unavailable" | "no_agent" | "gateway_not_connected" | "adapter_unavailable";
};

type MeetingBrokerConfig = {
  topic: string;
  npcs: MeetingNpcConfig[];
  gateway: unknown;
  userId: string;
  channelId: string;
  adapterRegistry: AdapterRegistry;
  sessionKeyPrefix: string;
  meetingId: string;
  settings: Record<string, unknown>;
  quota: {
    maxTotalTurns: number;
  };
};

type MeetingSummary = {
  keyTopics: string[];
  conclusions: string | null;
};

type MeetingBrokerLike = {
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
  onPollResult?: (raises: Array<{ agent: MeetingBrokerParticipant; reason: string }>, passes: string[]) => void;
  onTurnStart?: (agent: MeetingBrokerParticipant) => void;
  onTurnChunk?: (npcId: string, chunk: string) => void;
  onTurnEnd?: (npcId: string, fullResponse: string) => void;
  onModeChanged?: (mode: string, by: string) => void;
  onWaitingInput?: (pollResult: unknown) => void;
  onTurnAborted?: (npcId: string) => void;
  onMeetingEnd?: (transcript: string, durationSeconds?: number) => void | Promise<void>;
  onError?: (error: unknown) => void;
  /** 어댑터를 해석하지 못해 참가자 목록에서 제외된 NPC. 조용히 빼지 않고 알린다(요구사항). */
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
    getOrConnectGateway: (channelId: string) => Promise<unknown | null>;
    getNpcConfigsForChannel: (channelId: string) => Promise<MeetingNpcConfig[]>;
    canControlMeeting: (channelId: string, userId: string) => Promise<boolean> | boolean;
    createMeetingBroker?: (
      config: MeetingBrokerConfig,
      callbacks: MeetingBrokerCallbacks,
    ) => MeetingBrokerLike | Promise<MeetingBrokerLike>;
    generateMeetingSummary: (
      gateway: unknown,
      agentId: string,
      sessionKeyPrefix: string,
      meetingId: string,
      topic: string,
      transcript: string,
    ) => Promise<MeetingSummary>;
    persistMeetingMinutes: (input: PersistMeetingMinutesInput) => Promise<string | null>;
  };
};

function getMeetingRoomId(channelId: string) {
  return `meeting-${channelId}`;
}

/** OpenClaw 게이트웨이를 회의 하나(=참가자 하나) 범위로 닫아 NpcAdapter 모양으로 감싼다.
 * OpenClawAdapter.execute()는 게이트웨이가 없어 못 쓰므로 이 어댑터가 필요하다. */
function createOpenClawEngineAdapter(gateway: unknown, agentId: string): NpcAdapter {
  return {
    type: openclawAdapter.type,
    execute: (options) => openclawAdapter.executeWithGateway(gateway, options, agentId),
    abort: (sessionKey) => openclawAdapter.abortWithGateway(gateway, agentId, sessionKey),
    testConnection: (config) => openclawAdapter.testConnection(config),
  };
}

type ResolvedMeetingParticipant = {
  participant: MeetingBrokerParticipant;
  adapter: NpcAdapter;
  sessionKey: string;
};

/**
 * NPC 한 명을 실제 백엔드 어댑터로 해석한다. P1b 판정(HermesAdapter는 회의 하나당 한 번만 만들고
 * 그 회의 동안 재사용 — 여러 회의가 공유하는 싱글턴으로 등록하지 않는다)을 지키기 위해, 이 함수는
 * 회의 시작 시점에 참가자별로 정확히 한 번만 호출된다.
 */
async function resolveMeetingParticipant(
  npc: MeetingNpcConfig,
  ctx: {
    meetingId: string;
    userId: string;
    gateway: unknown;
    adapterRegistry: AdapterRegistry;
  },
): Promise<ResolvedMeetingParticipant | { excluded: ExcludedMeetingNpc }> {
  const adapterType = npc.adapterType || "openclaw";
  const hermesProfileId = npc.hermesProfileId ?? null;
  const dispatchKind = classifyNpcDispatch({ adapterType, hermesProfileId });
  const sessionKeyBase = npc.sessionKeyPrefix || npc.id;
  const sessionKey = `${sessionKeyBase}-meeting-${ctx.meetingId}`;

  const participantBase: MeetingBrokerParticipant = {
    npcId: npc.id,
    displayName: npc.name,
    role: npc.role || "Participant",
    passPolicy: npc.passPolicy || null,
    openclawAgentId: null,
  };

  if (dispatchKind === "unbound") {
    return { excluded: { npcId: npc.id, displayName: npc.name, reason: "unbound" } };
  }

  if (dispatchKind === "hermes") {
    const contextKey = deriveHermesContextKey(sessionKey, sessionKeyBase);
    const adapter = await createHermesAdapterForNpc(npc.id, ctx.userId, contextKey);
    if (!adapter) {
      return { excluded: { npcId: npc.id, displayName: npc.name, reason: "hermes_profile_unavailable" } };
    }
    return { participant: participantBase, adapter, sessionKey };
  }

  if (dispatchKind === "openclaw") {
    if (!npc.agentId) {
      return { excluded: { npcId: npc.id, displayName: npc.name, reason: "no_agent" } };
    }
    if (!ctx.gateway) {
      return { excluded: { npcId: npc.id, displayName: npc.name, reason: "gateway_not_connected" } };
    }
    return {
      participant: { ...participantBase, openclawAgentId: npc.agentId },
      adapter: createOpenClawEngineAdapter(ctx.gateway, npc.agentId),
      sessionKey,
    };
  }

  // dispatchKind === "registry"
  if (!ctx.adapterRegistry.has(adapterType)) {
    return { excluded: { npcId: npc.id, displayName: npc.name, reason: "adapter_unavailable" } };
  }
  return { participant: participantBase, adapter: ctx.adapterRegistry.get(adapterType), sessionKey };
}

async function defaultCreateMeetingBroker(
  config: MeetingBrokerConfig,
  callbacks: MeetingBrokerCallbacks,
): Promise<MeetingBrokerLike> {
  const resolved: ResolvedMeetingParticipant[] = [];
  const excluded: ExcludedMeetingNpc[] = [];

  for (const npc of config.npcs) {
    const result = await resolveMeetingParticipant(npc, {
      meetingId: config.meetingId,
      userId: config.userId,
      gateway: config.gateway,
      adapterRegistry: config.adapterRegistry,
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

  const engineParticipants: EngineParticipant[] = resolved.map(({ participant, adapter, sessionKey }) => ({
    npcId: participant.npcId,
    displayName: participant.displayName,
    seated: true,
    turnCount: 0,
    lastSpokeAt: 0,
    adapter,
    sessionKey,
  }));

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
      initialRunMode: (config.settings?.initialMode as RunMode) || "auto",
      hybridMode: Boolean(config.settings?.hybridMode),
      hybridAutoResumeMs: (config.settings?.hybridAutoResumeMs as number) ?? null,
    },
    {
      onPollStart: () => callbacks.onPollStart?.(),
      onPollResult: (raises, passes) => {
        callbacks.onPollResult?.(
          raises
            .map((r) => {
              const agent = participantByNpcId.get(r.npcId);
              return agent ? { agent, reason: r.reason } : null;
            })
            .filter((r): r is { agent: MeetingBrokerParticipant; reason: string } => r !== null),
          passes,
        );
      },
      onTurnStart: (npcId) => {
        const agent = participantByNpcId.get(npcId);
        if (agent) callbacks.onTurnStart?.(agent);
      },
      onTurnChunk: (npcId, chunk) => callbacks.onTurnChunk?.(npcId, chunk),
      onTurnEnd: (npcId, fullResponse) => callbacks.onTurnEnd?.(npcId, fullResponse),
      onModeChanged: (mode, source) => callbacks.onModeChanged?.(mode, source),
      onWaitingInput: (pollResult) => callbacks.onWaitingInput?.(pollResult),
      onError: (err) => callbacks.onError?.(err),
      onEnd: (finalTurns) => {
        turns = finalTurns;
        const transcript = generateTranscript(
          config.topic,
          finalTurns,
          resolved.map(({ participant }) => ({ displayName: participant.displayName, role: participant.role })),
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
    getOrConnectGateway,
    getNpcConfigsForChannel,
    canControlMeeting,
    createMeetingBroker = defaultCreateMeetingBroker,
    generateMeetingSummary,
    persistMeetingMinutes,
  } = deps;

  socket.on("meeting:start-discussion", async (payload: unknown) => {
    const {
      channelId,
      topic,
      settings,
      selectedNpcIds,
    } = (payload ?? {}) as {
      channelId?: string;
      topic?: string;
      settings?: Record<string, unknown> & { maxTotalTurns?: number; initialMode?: string };
      selectedNpcIds?: string[];
    };

    if (!channelId || !topic) return;
    if (activeBrokers.has(channelId)) {
      socket.emit("meeting:error", { error: "A meeting is already in progress" });
      return;
    }

    // 게이트웨이는 openclaw 참가자를 해석할 때만 필요하다 — hermes/registry 전용 회의는 게이트웨이가
    // 없어도 시작할 수 있어야 한다(이번 전환의 취지). 없으면 openclaw NPC만 제외 대상이 된다.
    const gateway = await getOrConnectGateway(channelId);

    const npcConfigs = await getNpcConfigsForChannel(channelId);
    let candidateNpcs = npcConfigs;

    if (selectedNpcIds && selectedNpcIds.length > 0) {
      const selectedSet = new Set(selectedNpcIds);
      candidateNpcs = candidateNpcs.filter((npc) => selectedSet.has(npc.id));
    }

    if (candidateNpcs.length === 0) {
      socket.emit("meeting:error", { error: "No AI NPCs in this channel" });
      return;
    }

    const meetingParticipants: Array<{ id: string; name: string; type: "npc" | "player"; agentId?: string }> = [
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
    const sessionKeyPrefix = candidateNpcs[0].sessionKeyPrefix || channelId.slice(0, 8);

    const brokerInstance = await createMeetingBroker(
      {
        topic,
        npcs: candidateNpcs,
        gateway,
        userId: user.userId,
        channelId,
        adapterRegistry,
        sessionKeyPrefix,
        meetingId,
        settings: settings || {},
        quota: {
          maxTotalTurns: settings?.maxTotalTurns || 50,
        },
      },
      {
        onPollStart: () => {
          io.to(getMeetingRoomId(channelId)).emit("meeting:poll-status", { status: "polling" });
        },
        onPollResult: (raises, passes) => {
          io.to(getMeetingRoomId(channelId)).emit("meeting:poll-status", {
            raises: raises.map((raise) => ({ name: raise.agent.displayName, reason: raise.reason })),
            passes,
          });
        },
        onTurnStart: (agent) => {
          io.to(getMeetingRoomId(channelId)).emit("meeting:npc-turn-start", {
            npcId: agent.npcId,
            npcName: agent.displayName,
          });
        },
        onTurnChunk: (npcId, chunk) => {
          io.to(getMeetingRoomId(channelId)).emit(MEETING_NPC_STREAM_EVENT, {
            npcId,
            chunk,
            done: false,
          });
        },
        onTurnEnd: (npcId, fullResponse) => {
          const agent = brokerInstance.config.participants.find((participant) => participant.npcId === npcId);
          io.to(getMeetingRoomId(channelId)).emit(MEETING_NPC_STREAM_EVENT, {
            npcId,
            npcName: agent?.displayName || npcId,
            chunk: "",
            done: true,
          });

          const liveRoom = meetingRooms.get(channelId);
          if (!liveRoom) return;

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
          io.to(getMeetingRoomId(channelId)).emit("meeting:mode-changed", { mode, by });
        },
        onWaitingInput: (pollResult) => {
          io.to(getMeetingRoomId(channelId)).emit("meeting:waiting-input", { pollResult });
        },
        onTurnAborted: (npcId) => {
          io.to(getMeetingRoomId(channelId)).emit("meeting:turn-aborted", { npcId });
        },
        onParticipantsExcluded: (excluded) => {
          const names = excluded.map((e) => e.displayName).join(", ");
          io.to(getMeetingRoomId(channelId)).emit("meeting:error", {
            error: `Excluded from the meeting (no usable backend): ${names}`,
          });
        },
        onMeetingEnd: async (transcript, durationSeconds) => {
          let summary: MeetingSummary = { keyTopics: [], conclusions: null };
          const firstAgent = brokerInstance.config.participants[0];

          if (gateway && firstAgent?.openclawAgentId) {
            summary = await generateMeetingSummary(
              gateway,
              firstAgent.openclawAgentId,
              brokerInstance.config.sessionKeyPrefix || sessionKeyPrefix,
              brokerInstance.config.meetingId || meetingId,
              topic,
              transcript,
            );
          }

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
          });

          io.to(getMeetingRoomId(channelId)).emit("meeting:end", {
            transcript,
            keyTopics: summary.keyTopics,
            conclusions: summary.conclusions,
            minutesId,
            totalTurns: brokerInstance.turns.length,
            durationSeconds,
          });

          activeBrokers.delete(channelId);
          discussionInitiators.delete(channelId);
        },
        onError: (error) => {
          io.to(getMeetingRoomId(channelId)).emit("meeting:error", { error });
        },
      },
    );

    activeBrokers.set(channelId, brokerInstance);
    discussionInitiators.set(channelId, user.userId);

    brokerInstance.run().catch((error) => {
      console.error("[meeting] Broker error:", error);
      activeBrokers.delete(channelId);
      discussionInitiators.delete(channelId);
      io.to(getMeetingRoomId(channelId)).emit("meeting:error", {
        error: "Meeting ended due to error",
      });
    });

    io.to(getMeetingRoomId(channelId)).emit("meeting:mode-changed", {
      mode: settings?.initialMode || "auto",
      by: user.userId,
      initiatorId: user.userId,
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

  socket.on("meeting:stop", (payload: unknown) => {
    const { channelId } = (payload ?? {}) as { channelId?: string };
    if (!channelId) return;

    const broker = activeBrokers.get(channelId);
    if (!broker) return;

    broker.stop();
    discussionInitiators.delete(channelId);
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
