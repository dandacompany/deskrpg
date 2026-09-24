import type { MeetingDiscussionState } from "../lib/meeting-discussion-state";
import type { MeetingSpatialCoordinator } from "./meeting-spatial-coordinator";
import { normalizeOfficeAppearance } from "@/game/three/office-appearance";
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
    getDiscussionState?: (channelId: string) => MeetingDiscussionState | null;
    spatial?: MeetingSpatialCoordinator;
    isInMeetingSpace?: (channelId: string, socketId: string) => Promise<boolean>;
    players: Map<string, MeetingPlayer>;
    lastChatTime: Map<string, number>;
    chatCooldownMs: number;
    user: { userId: string; nickname?: string | null };
    getParticipationAccess?: (
      channelId: string,
      userId: string,
    ) => Promise<ChannelAccessResult | null>;
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

export function emitMeetingNpcStream(io: MeetingIo, channelId: string, payload: unknown) {
  io.to(getMeetingRoomId(channelId)).emit(MEETING_NPC_STREAM_EVENT, payload);
}

/**
 * Delivers a finished NPC answer to the meeting room for good, then persists the session ref best-effort.
 *
 * Ordering and isolation are all this function is about. If persistence is awaited before the final emit (and it
 * is not wrapped), a single transient DB error wipes out an answer that was already generated —
 * the caller's catch pops the answer from room.messages, and done:true never goes out, so the client's
 * streaming bubble stays open forever. Losing the session ref loses conversation continuity, but
 * losing the answer loses the user's turn itself.
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
    (
      steps.onPersistError ??
      ((e: unknown) => console.error("[meeting] session ref persist failed:", e))
    )(err);
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

  // Pre-join CTA discovery is requester-only and never subscribes to meeting content.
  socket.on("meeting:availability", async (payload: unknown) => {
    const { channelId } = (payload ?? {}) as { channelId?: unknown };
    if (typeof channelId !== "string" || !channelId) return;
    const deny = (reason?: string) => {
      if (emitChannelAccessDenied) {
        emitChannelAccessDenied(socket, { channelId, action: "meeting:availability", reason });
      } else {
        emitForbidden(socket, channelId, "meeting:availability");
      }
    };
    if (players.get(socket.id)?.mapId !== channelId || !getParticipationAccess) {
      deny("forbidden");
      return;
    }
    const accessResult = await getParticipationAccess(channelId, user.userId).catch(() => null);
    if (players.get(socket.id)?.mapId !== channelId || !accessResult?.access.allowed) {
      deny(accessResult?.access.reason ?? "forbidden");
      return;
    }
    const spatial = deps.spatial?.snapshot(channelId);
    const active =
      deps.getDiscussionState?.(channelId) != null ||
      ((spatial?.phase === "assembling" || spatial?.phase === "ready") &&
        spatial.participants.some((participant) => participant.kind === "npc"));
    socket.emit("meeting:availability", { channelId, active });
  });

  const joinGenerations = new Map<string, number>();
  let disconnected = false;
  let admissionQueue = Promise.resolve();
  const enqueueAdmission = (operation: () => Promise<void>) => {
    const pending = admissionQueue.then(operation);
    admissionQueue = pending.catch(() => {});
    return pending;
  };
  const invalidateJoin = (channelId: string) => {
    const generation = (joinGenerations.get(channelId) ?? 0) + 1;
    joinGenerations.set(channelId, generation);
    return generation;
  };
  socket.on("disconnect", () => {
    disconnected = true;
  });

  socket.on("meeting:join", (payload: unknown) => {
    const input = (payload ?? {}) as {
      channelId?: string;
      characterName?: string;
      appearance?: unknown;
    };
    const { channelId, characterName, appearance } = input;
    if (typeof channelId !== "string" || !channelId) return;
    const generation = invalidateJoin(channelId);
    const requestPlayer = players.get(socket.id);
    const samePlayer = () =>
      !disconnected &&
      players.get(socket.id) === requestPlayer &&
      players.get(socket.id)?.mapId === channelId;
    const current = () => samePlayer() && joinGenerations.get(channelId) === generation;
    // Serialize admission and release so an old rollback cannot release a newer seat.
    return enqueueAdmission(async () => {
      if (!current()) return;

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
              reason: accessResult.access.reason as Parameters<
                NonNullable<typeof emitChannelAccessDenied>
              >[1]["reason"],
            });
          } else {
            emitForbidden(socket, channelId, "meeting:join");
          }
          return;
        }
      }

      if (!current()) return;
      if (
        deps.isInMeetingSpace &&
        !(await deps.isInMeetingSpace(channelId, socket.id).catch(() => false))
      ) {
        socket.emit("meeting:error", { error: "not_in_meeting_space" });
        return;
      }
      if (!current()) return;
      const room = ensureMeetingRoom(meetingRooms, channelId);
      const alreadyAdmitted = room.participants.has(socket.id);
      room.participants.add(socket.id);
      socket.join(getMeetingRoomId(channelId));
      await deps.spatial?.joinPlayer(channelId, user.userId, socket.id);
      const stillInside =
        samePlayer() &&
        room.participants.has(socket.id) &&
        (!deps.isInMeetingSpace ||
          (await deps.isInMeetingSpace(channelId, socket.id).catch(() => false)));
      if (!current() || !room.participants.has(socket.id) || !stillInside) {
        // Superseding a duplicate read must not release an existing participant's seat.
        // Actual leave, movement, or disconnect still tears down the admission.
        if (alreadyAdmitted && samePlayer() && room.participants.has(socket.id) && stillInside)
          return;
        room.participants.delete(socket.id);
        socket.leave(getMeetingRoomId(channelId));
        await deps.spatial?.leavePlayer(channelId, user.userId, socket.id);
        return;
      }

      const existingPlayer = players.get(socket.id);
      const displayName =
        existingPlayer?.characterName || characterName || user.nickname || "Unknown";
      // Appearance sent by the client is not rejected; it is normalized and relayed.
      const displayAppearance = normalizeOfficeAppearance(
        existingPlayer?.appearance ?? appearance ?? null,
      );

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
            userId: participantId === socket.id ? user.userId : participant.userId,
            name: participant.characterName || "Unknown",
            appearance: participant.appearance,
          };
        })
        .filter(Boolean);

      socket.emit("meeting:state", {
        participants: participantList,
        messages: room.messages.slice(-50),
        discussion: deps.getDiscussionState?.(channelId) ?? null,
        spatial: deps.spatial?.snapshot(channelId) ?? null,
        isInitiator: deps.getDiscussionState?.(channelId)?.initiatorId === user.userId,
      });

      socket.to(getMeetingRoomId(channelId)).emit("meeting:participant-joined", {
        id: socket.id,
        userId: user.userId,
        name: displayName,
        appearance: displayAppearance,
      });
    });
  });

  socket.on("meeting:leave", (payload: unknown) => {
    const { channelId } = (payload ?? {}) as { channelId?: string };
    if (typeof channelId !== "string" || !channelId) return;
    invalidateJoin(channelId);
    const room = meetingRooms.get(channelId);
    if (!room || !room.participants.has(socket.id)) return;
    room.participants.delete(socket.id);
    void enqueueAdmission(async () => {
      await deps.spatial?.leavePlayer(channelId, user.userId, socket.id);
    });
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
            reason: accessResult.access.reason as Parameters<
              NonNullable<typeof emitChannelAccessDenied>
            >[1]["reason"],
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
