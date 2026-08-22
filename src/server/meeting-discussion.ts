import { MEETING_NPC_STREAM_EVENT } from "./meeting-socket";
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

// 회의는 소켓 이벤트로만 흐르고 HTTP 로그를 남기지 않는다. 그래서 "화면에는 시작됐다고
// 뜨는데 아무도 발언하지 않는" 상태가 되면 서버 쪽에 단서가 하나도 없다 — 실제로 그
// 상태를 진단하는 데 e2e 를 두 번 5분씩 돌려야 했다. DEBUG_CHAT 과 같은 스위치를 쓴다.
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
};

type MeetingSummary = {
  keyTopics: string[];
  conclusions: string | null;
};

export type MeetingBrokerLike = {
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
  /** 지목받았으나 할당량이 없어 건너뛴 NPC. onParticipantsExcluded 와 같은 계열. */
  onMentionSkipped?: (npcId: string, reason: "quota_exhausted") => void;
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
    getNpcConfigsForChannel: (channelId: string) => Promise<MeetingNpcConfig[]>;
    canControlMeeting: (channelId: string, userId: string) => Promise<boolean> | boolean;
    createMeetingBroker?: (
      config: MeetingBrokerConfig,
      callbacks: MeetingBrokerCallbacks,
    ) => MeetingBrokerLike | Promise<MeetingBrokerLike>;
    /** 회의 요약. 예전에는 OpenClaw 게이트웨이의 chatSend 에 직접 매여 있어서
     * `gateway && openclawAgentId` 인 회의에서만 돌았다 — 즉 Hermes 회의는 늘 빈 요약을
     * 남겼다. 이제 참가자 어댑터를 그대로 받아 백엔드와 무관하게 돈다. */
    generateMeetingSummary: (
      adapter: NpcAdapter,
      sessionKey: string,
      topic: string,
      transcript: string,
    ) => Promise<MeetingSummary>;
    persistMeetingMinutes: (input: PersistMeetingMinutesInput) => Promise<string | null>;
  };
};

/** setMode와 같은 기준으로 검증한다(conversation-engine.ts:setMode). 알 수 없는 값은 "auto". */
function toRunMode(value: unknown): RunMode {
  return value === "auto" || value === "manual" || value === "directed" ? value : "auto";
}

function getMeetingRoomId(channelId: string) {
  return `meeting-${channelId}`;
}

/** createHermesAdapterForNpc와 같은 모양 — 프로필을 못 찾으면 null. */
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
 * NPC 한 명을 실제 백엔드 어댑터로 해석한다. P1b 판정(HermesAdapter는 회의 하나당 한 번만 만들고
 * 그 회의 동안 재사용 — 여러 회의가 공유하는 싱글턴으로 등록하지 않는다)을 지키기 위해, 이 함수는
 * 회의 시작 시점에 참가자별로 정확히 한 번만 호출된다.
 */
export async function resolveMeetingParticipant(
  npc: MeetingNpcConfig,
  ctx: {
    meetingId: string;
    userId: string;
    adapterRegistry: AdapterRegistry;
    /** 테스트에서 DB·게이트웨이 없이 hermes 갈래를 관찰하기 위한 주입점. 기본값이 실제 배선이다. */
    createHermesAdapter?: CreateHermesAdapter;
  },
): Promise<ResolvedMeetingParticipant | { excluded: ExcludedMeetingNpc }> {
  const adapterType = npc.adapterType || "hermes";
  const hermesProfileId = npc.hermesProfileId ?? null;
  const dispatchKind = classifyNpcDispatch({ adapterType, hermesProfileId });
  const sessionKeyBase = npc.sessionKeyPrefix || npc.id;
  const sessionKey = `${sessionKeyBase}-meeting-${ctx.meetingId}`;

  const participantBase: MeetingBrokerParticipant = {
    npcId: npc.id,
    displayName: npc.name,
    role: npc.role || "Participant",
    passPolicy: npc.passPolicy || null,
  };

  if (dispatchKind === "unbound") {
    return { excluded: { npcId: npc.id, displayName: npc.name, reason: "unbound" } };
  }

  if (dispatchKind === "hermes") {
    const contextKey = deriveHermesContextKey(sessionKey, sessionKeyBase);
    const createAdapter = ctx.createHermesAdapter ?? createHermesAdapterForNpc;
    const adapter = await createAdapter(npc.id, ctx.userId, contextKey);
    if (!adapter) {
      return { excluded: { npcId: npc.id, displayName: npc.name, reason: "hermes_profile_unavailable" } };
    }
    return { participant: participantBase, adapter, sessionKey };
  }

  if (dispatchKind === "openclaw") {
    // OpenClaw 는 제거됐다. 남아 있는 openclaw NPC 는 회의에서 조용히 빠지는 대신
    // 이유를 달고 제외되어, 사용자가 다시 연결해야 한다는 것을 알 수 있게 한다.
    return { excluded: { npcId: npc.id, displayName: npc.name, reason: "unbound" } };
  }

  // dispatchKind === "registry"
  if (!ctx.adapterRegistry.has(adapterType)) {
    return { excluded: { npcId: npc.id, displayName: npc.name, reason: "adapter_unavailable" } };
  }
  return { participant: participantBase, adapter: ctx.adapterRegistry.get(adapterType), sessionKey };
}

export async function defaultCreateMeetingBroker(
  config: MeetingBrokerConfig,
  callbacks: MeetingBrokerCallbacks,
  deps: { createHermesAdapter?: CreateHermesAdapter } = {},
): Promise<MeetingBrokerLike> {
  const resolved: ResolvedMeetingParticipant[] = [];
  const excluded: ExcludedMeetingNpc[] = [];

  for (const npc of config.npcs) {
    const result = await resolveMeetingParticipant(npc, {
      meetingId: config.meetingId,
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

  const engineParticipants: EngineParticipant[] = resolved.map(({ participant, adapter, sessionKey }) => ({
    npcId: participant.npcId,
    displayName: participant.displayName,
    seated: true,
    turnCount: 0,
    lastSpokeAt: 0,
    adapter,
    sessionKey,
    role: participant.role,
    passPolicy: participant.passPolicy,
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
      // 캐스팅이 아니라 검증한다 — 엔진 생성자는 setMode와 달리 값을 검사하지 않아서,
      // 잘못된 값은 auto처럼 동작하면서 meeting:mode-changed로 그 잘못된 문자열을
      // 클라이언트에 되돌려주는 상태로 남는다.
      initialRunMode: toRunMode(config.settings?.initialMode),
      hybridMode: Boolean(config.settings?.hybridMode),
      hybridAutoResumeMs: (config.settings?.hybridAutoResumeMs as number) ?? null,
    },
    {
      onPollStart: () => callbacks.onPollStart?.(),
      onPollResult: (raises, passes) => {
        meetingLog("폴링 결과: raises=", raises.map((r) => r.npcId).join(",") || "(없음)", "passes=", passes.join(",") || "(없음)");
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

    meetingLog("start-discussion 수신:", { channelId, topic: topic?.slice(0, 40), selectedNpcIds });
    if (!channelId || !topic) return;
    if (activeBrokers.has(channelId)) {
      socket.emit("meeting:error", { error: "A meeting is already in progress" });
      return;
    }

    // 예전에는 여기서 getOrConnectGateway(channelId) 를 조건 없이 await 했다. 주석은
    // "openclaw 참가자를 해석할 때만 필요하다"고 적혀 있었지만 코드는 늘 불렀고, Hermes
    // 게이트웨이가 OpenClaw WS 핸드셰이크에 403 을 돌려주면 그 자리에서 매달렸다 —
    // 화면에는 "토론이 시작되었습니다"만 뜬 채 첫 턴이 영영 디스패치되지 않았다.
    // OpenClaw 가 사라진 지금은 획득할 게이트웨이 자체가 없다.

    const npcConfigs = await getNpcConfigsForChannel(channelId);
    let candidateNpcs = npcConfigs;

    if (selectedNpcIds && selectedNpcIds.length > 0) {
      const selectedSet = new Set(selectedNpcIds);
      candidateNpcs = candidateNpcs.filter((npc) => selectedSet.has(npc.id));
    }

    meetingLog("후보 NPC:", candidateNpcs.map((n) => `${n.name}(${n.adapterType})`).join(", ") || "(없음)");
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

    // 요약용 어댑터는 회의 참가자와 **별도로** 한 번 해석한다. 브로커의 config.participants
    // 는 어댑터를 담지 않는 조회용 뷰이므로(위 타입 주석 참조) 밖에서는 닿을 수 없고,
    // 요약 세션은 어차피 회의 세션과 분리되어야 한다 — 요약 프롬프트가 그 NPC 의 회의
    // 맥락에 섞이면 다음 회의 발언이 오염된다.
    const summarizerResolution = await resolveMeetingParticipant(candidateNpcs[0], {
      meetingId: `${meetingId}-summary`,
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
          // 중단된 턴은 부분 텍스트조차 없을 수 있다 — 말풍선은 위에서 닫아주되 빈 메시지를
          // 회의 기록에 남기지는 않는다.
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
          io.to(getMeetingRoomId(channelId)).emit("meeting:mode-changed", { mode, by });
        },
        onWaitingInput: (pollResult) => {
          io.to(getMeetingRoomId(channelId)).emit("meeting:waiting-input", { pollResult });
        },
        onTurnAborted: (npcId) => {
          io.to(getMeetingRoomId(channelId)).emit("meeting:turn-aborted", { npcId });
        },
        onParticipantsExcluded: (excluded) => {
          meetingLog("제외:", excluded.map((e) => `${e.displayName}=${e.reason}`).join(", "));
          const names = excluded.map((e) => e.displayName).join(", ");
          io.to(getMeetingRoomId(channelId)).emit("meeting:error", {
            error: `Excluded from the meeting (no usable backend): ${names}`,
          });
        },
        onMeetingEnd: async (transcript, durationSeconds) => {
          let summary: MeetingSummary = { keyTopics: [], conclusions: null };
          // 참가자 중 아무나 한 명에게 요약을 시킨다. 요약 세션 키는 회의 세션과 분리해
          // 요약 프롬프트가 그 NPC 의 회의 맥락에 섞이지 않게 한다.
          if (summarizerAdapter) {
            const summaryKey = `${brokerInstance.config.sessionKeyPrefix || sessionKeyPrefix}-summary-${
              brokerInstance.config.meetingId || meetingId
            }`;
            summary = await generateMeetingSummary(summarizerAdapter, summaryKey, topic, transcript);
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

    // 어댑터 해석 결과 참가 가능한 NPC가 하나도 남지 않으면(전부 unbound/미해석) 조용히 빈 회의를
    // 시작-즉시종료하지 않고, 시작 전 검사와 동일하게 실패로 끝낸다. 제외 사유는
    // onParticipantsExcluded가 이미 개별 통지했다 — 이건 "그래서 회의 자체가 시작되지 않았다"는
    // 별도의 최종 신호다.
    if (brokerInstance.config.participants.length === 0) {
      socket.emit("meeting:error", { error: "No AI NPCs in this channel" });
      return;
    }

    meetingLog(
      "브로커 시작:",
      brokerInstance.config.participants.map((p) => p.displayName).join(", "),
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
