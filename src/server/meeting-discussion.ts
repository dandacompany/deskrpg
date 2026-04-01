import { MEETING_NPC_STREAM_EVENT } from "./meeting-socket";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { MeetingBroker } = require("../lib/meeting-broker.js") as {
  MeetingBroker: new (config: MeetingBrokerConfig, callbacks: MeetingBrokerCallbacks) => MeetingBrokerLike;
};

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

type MeetingBrokerParticipant = {
  agentId: string;
  displayName: string;
  role: string;
  passPolicy: string | null;
};

type MeetingBrokerConfig = {
  topic: string;
  participants: MeetingBrokerParticipant[];
  gateway: unknown;
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
  onTurnChunk?: (agentId: string, chunk: string) => void;
  onTurnEnd?: (agentId: string, fullResponse: string) => void;
  onModeChanged?: (mode: string, by: string) => void;
  onWaitingInput?: (pollResult: unknown) => void;
  onTurnAborted?: (npcId: string) => void;
  onMeetingEnd?: (transcript: string, durationSeconds?: number) => void | Promise<void>;
  onError?: (error: string) => void;
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
    getOrConnectGateway: (channelId: string) => Promise<unknown | null>;
    getNpcConfigsForChannel: (channelId: string) => Promise<MeetingNpcConfig[]>;
    canControlMeeting: (channelId: string, userId: string) => Promise<boolean> | boolean;
    createMeetingBroker?: (
      config: MeetingBrokerConfig,
      callbacks: MeetingBrokerCallbacks,
    ) => MeetingBrokerLike;
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

function defaultCreateMeetingBroker(config: MeetingBrokerConfig, callbacks: MeetingBrokerCallbacks) {
  return new MeetingBroker(config, callbacks);
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

    const gateway = await getOrConnectGateway(channelId);
    if (!gateway) {
      socket.emit("meeting:error", { error: "No AI Gateway connected" });
      return;
    }

    const npcConfigs = await getNpcConfigsForChannel(channelId);
    let aiNpcs = npcConfigs.filter((npc) => npc.agentId);

    if (selectedNpcIds && selectedNpcIds.length > 0) {
      const selectedSet = new Set(selectedNpcIds);
      aiNpcs = aiNpcs.filter((npc) => selectedSet.has(npc.id));
    }

    if (aiNpcs.length === 0) {
      socket.emit("meeting:error", { error: "No AI NPCs in this channel" });
      return;
    }

    const participants: MeetingBrokerParticipant[] = aiNpcs.map((npc) => ({
      agentId: npc.agentId!,
      displayName: npc.name,
      role: npc.role || "Participant",
      passPolicy: npc.passPolicy || null,
    }));

    const meetingParticipants: Array<{ id: string; name: string; type: "npc" | "player"; agentId?: string }> = [
      ...aiNpcs.map((npc) => ({
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
    const brokerInstance = createMeetingBroker(
      {
        topic,
        participants,
        gateway,
        sessionKeyPrefix: aiNpcs[0].sessionKeyPrefix || channelId.slice(0, 8),
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
            npcId: agent.agentId,
            npcName: agent.displayName,
          });
        },
        onTurnChunk: (agentId, chunk) => {
          io.to(getMeetingRoomId(channelId)).emit(MEETING_NPC_STREAM_EVENT, {
            npcId: agentId,
            chunk,
            done: false,
          });
        },
        onTurnEnd: (agentId, fullResponse) => {
          io.to(getMeetingRoomId(channelId)).emit(MEETING_NPC_STREAM_EVENT, {
            npcId: agentId,
            npcName: participants.find((participant) => participant.agentId === agentId)?.displayName || agentId,
            chunk: "",
            done: true,
          });

          const liveRoom = meetingRooms.get(channelId);
          if (!liveRoom) return;

          const agent = participants.find((participant) => participant.agentId === agentId);
          liveRoom.messages.push({
            id: `msg-${Date.now()}-${agentId}`,
            sender: agent?.displayName || agentId,
            senderId: `npc-${agentId}`,
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
        onMeetingEnd: async (transcript, durationSeconds) => {
          let summary: MeetingSummary = { keyTopics: [], conclusions: null };
          const firstAgent = participants[0];

          if (gateway && firstAgent?.agentId) {
            summary = await generateMeetingSummary(
              gateway,
              firstAgent.agentId,
              brokerInstance.config.sessionKeyPrefix || aiNpcs[0].sessionKeyPrefix || channelId.slice(0, 8),
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

    const agent = broker.config.participants.find((participant) => participant.agentId === npcId);
    if (!agent?.agentId) {
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
