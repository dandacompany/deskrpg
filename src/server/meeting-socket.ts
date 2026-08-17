export const MEETING_NPC_STREAM_EVENT = "meeting:npc-stream";

type MeetingRoom = {
  participants: Set<string>;
  messages: Array<{
    id: string;
    sender: string;
    senderId: string;
    senderType: "user" | "npc";
    content: string;
    timestamp: number;
  }>;
};

type MeetingPlayer = {
  id?: string;
  characterName?: string | null;
  appearance?: unknown;
  userId?: string;
  mapId?: string;
  x?: number;
  y?: number;
  direction?: string;
  animation?: string;
};

type ChannelAccessResult = {
  access: {
    allowed: boolean;
    reason?: string;
  };
};

type MeetingSocket = {
  id: string;
  on(event: string, handler: (payload: unknown) => unknown): void;
  emit(event: string, payload: unknown): void;
  join(room: string): void;
  leave(room: string): void;
  to(room: string): {
    emit(event: string, payload: unknown): void;
  };
};

type MeetingIo = {
  to(room: string): {
    emit(event: string, payload: unknown): void;
  };
};

type MeetingMessage = {
  id: string;
  sender: string;
  senderId: string;
  senderType: "user" | "npc";
  content: string;
  timestamp: number;
};

type RegisterMeetingSocketHandlersArgs = {
  io: MeetingIo;
  socket: MeetingSocket;
  deps: {
    meetingRooms: Map<string, MeetingRoom>;
    players: Map<string, MeetingPlayer>;
    lastChatTime: Map<string, number>;
    chatCooldownMs: number;
    user: { userId: string; nickname?: string | null };
    getParticipationAccess?: (channelId: string, userId: string) => Promise<ChannelAccessResult | null>;
    emitChannelAccessDenied?: (
      socket: MeetingSocket,
      input: { channelId: string; action: string; reason?: string },
    ) => void;
    storeMeetingFallbackPlayer?: boolean;
    onMeetingChat?: (input: {
      channelId: string;
      message: string;
      room: MeetingRoom;
      player: MeetingPlayer | undefined;
      userMessage: MeetingMessage;
    }) => Promise<void> | void;
  };
};

function emitForbidden(socket: MeetingSocket, channelId: string, action: string) {
  socket.emit("channel:access-denied", {
    channelId,
    action,
    reason: "forbidden",
    errorCode: "forbidden",
  });
}

function ensureMeetingRoom(meetingRooms: Map<string, MeetingRoom>, channelId: string) {
  let room = meetingRooms.get(channelId);
  if (!room) {
    room = { participants: new Set(), messages: [] };
    meetingRooms.set(channelId, room);
  }
  return room;
}

function getMeetingRoomId(channelId: string) {
  return `meeting-${channelId}`;
}

export function emitMeetingNpcStream(
  io: MeetingIo,
  channelId: string,
  payload: unknown,
) {
  io.to(getMeetingRoomId(channelId)).emit(MEETING_NPC_STREAM_EVENT, payload);
}

/**
 * 생성이 끝난 NPC 답변을 회의방에 확정 전달한 뒤, 세션 참조 영속화를 best-effort로 수행한다.
 *
 * 순서와 격리가 이 함수의 전부다. 영속화를 종료 emit보다 먼저 await하면(그리고 그것이
 * 감싸이지 않으면) 일시적인 DB 오류 하나가 이미 생성된 답변을 통째로 날린다 —
 * 호출부의 catch가 room.messages에서 답변을 pop하고, done:true가 나가지 않아 클라이언트의
 * 스트리밍 말풍선이 영영 열린 채로 남는다. 세션 참조를 잃으면 대화 연속성을 잃지만,
 * 답변을 잃으면 사용자의 턴 자체를 잃는다.
 */
export async function deliverMeetingNpcAnswer(steps: {
  emitDone: () => void;
  emitMessage: () => void;
  persistSessionRef?: (() => Promise<void>) | null;
  onPersistError?: (err: unknown) => void;
}): Promise<void> {
  steps.emitDone();
  steps.emitMessage();
  if (!steps.persistSessionRef) return;
  try {
    await steps.persistSessionRef();
  } catch (err) {
    (steps.onPersistError ?? ((e: unknown) => console.error("[meeting] session ref persist failed:", e)))(err);
  }
}

export function registerMeetingSocketHandlers({
  io,
  socket,
  deps,
}: RegisterMeetingSocketHandlersArgs) {
  const {
    meetingRooms,
    players,
    lastChatTime,
    chatCooldownMs,
    user,
    getParticipationAccess,
    emitChannelAccessDenied,
    storeMeetingFallbackPlayer,
    onMeetingChat,
  } = deps;

  socket.on("meeting:join", async (payload: unknown) => {
    const input = (payload ?? {}) as {
      channelId?: string;
      characterName?: string;
      appearance?: unknown;
    };
    const { channelId, characterName, appearance } = input;
    if (!channelId) return;

    if (getParticipationAccess) {
      const accessResult = await getParticipationAccess(channelId, user.userId);
      if (!accessResult) {
        emitForbidden(socket, channelId, "meeting:join");
        return;
      }

        if (!accessResult.access.allowed) {
          if (emitChannelAccessDenied) {
            emitChannelAccessDenied(socket, {
              channelId,
              action: "meeting:join",
              reason: accessResult.access.reason as Parameters<NonNullable<typeof emitChannelAccessDenied>>[1]["reason"],
            });
          } else {
          emitForbidden(socket, channelId, "meeting:join");
        }
        return;
      }
    }

    const room = ensureMeetingRoom(meetingRooms, channelId);
    room.participants.add(socket.id);
    socket.join(getMeetingRoomId(channelId));

    const existingPlayer = players.get(socket.id);
    const displayName =
      existingPlayer?.characterName || characterName || user.nickname || "Unknown";
    const displayAppearance = existingPlayer?.appearance ?? appearance ?? null;

    if (!existingPlayer && storeMeetingFallbackPlayer) {
      players.set(socket.id, {
        id: socket.id,
        userId: user.userId,
        characterName: displayName,
        appearance: displayAppearance,
        mapId: channelId,
        x: 0,
        y: 0,
        direction: "down",
        animation: "idle",
      });
    }

    const participantList = Array.from(room.participants)
      .map((participantId) => {
        const participant = players.get(participantId);
        if (!participant) return null;
        return {
          id: participantId,
          name: participant.characterName || "Unknown",
          appearance: participant.appearance,
        };
      })
      .filter(Boolean);

    socket.emit("meeting:state", {
      participants: participantList,
      messages: room.messages.slice(-50),
    });

    socket.to(getMeetingRoomId(channelId)).emit("meeting:participant-joined", {
      id: socket.id,
      name: displayName,
      appearance: displayAppearance,
    });
  });

  socket.on("meeting:leave", (payload: unknown) => {
    const { channelId } = (payload ?? {}) as { channelId?: string };
    if (!channelId) return;
    const room = meetingRooms.get(channelId);
    if (!room) return;
    room.participants.delete(socket.id);
    socket.leave(getMeetingRoomId(channelId));
    socket.to(getMeetingRoomId(channelId)).emit("meeting:participant-left", {
      id: socket.id,
    });
  });

  socket.on("meeting:chat", async (payload: unknown) => {
    const input = (payload ?? {}) as {
      channelId?: string;
      message?: string;
    };
    const { channelId, message } = input;
    if (!channelId || !message) return;

    if (getParticipationAccess) {
      const accessResult = await getParticipationAccess(channelId, user.userId);
      if (!accessResult) {
        emitForbidden(socket, channelId, "meeting:chat");
        return;
      }

      if (!accessResult.access.allowed) {
        if (emitChannelAccessDenied) {
          emitChannelAccessDenied(socket, {
            channelId,
            action: "meeting:chat",
            reason: accessResult.access.reason as Parameters<NonNullable<typeof emitChannelAccessDenied>>[1]["reason"],
          });
        } else {
          emitForbidden(socket, channelId, "meeting:chat");
        }
        return;
      }
    }

    const room = meetingRooms.get(channelId);
    if (!room || !room.participants.has(socket.id)) {
      emitForbidden(socket, channelId, "meeting:chat");
      return;
    }

    const now = Date.now();
    if (now - (lastChatTime.get(socket.id) || 0) < chatCooldownMs) return;
    lastChatTime.set(socket.id, now);

    const trimmed = String(message).trim().slice(0, 500);
    if (!trimmed) return;

    const player = players.get(socket.id);
    const userMessage = {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      sender: player?.characterName || "Unknown",
      senderId: socket.id,
      senderType: "user" as const,
      content: trimmed,
      timestamp: now,
    };

    room.messages.push(userMessage);
    if (room.messages.length > 100) {
      room.messages.splice(0, room.messages.length - 100);
    }

    io.to(getMeetingRoomId(channelId)).emit("meeting:message", userMessage);

    await onMeetingChat?.({
      channelId,
      message: trimmed,
      room,
      player,
      userMessage,
    });
  });
}
