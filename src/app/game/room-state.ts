import { sortRooms, type RoomMessage, type RoomSummary } from "@/lib/chat-rooms-policy";

/**
 * State of the channel chat room screen. A pure reducer that knows neither socket nor React — `node:test` can cover it.
 *
 * `view` is three screens: the room list (`list`), inside a room (`room`), composing a new room/invite (`compose`).
 * The list is the entry point to creating a new room even when there is only one room.
 */
export type RoomState = {
  rooms: RoomSummary[];
  /**
   * The user id of the person using this browser. The server carries it in `room:list-response` —
   * the client has no other way to know its identity, and without it "rooms I created" cannot be told apart.
   */
  viewerUserId: string | null;
  currentRoomId: string | null;
  messages: Record<string, RoomMessage[]>;
  view: "list" | "room" | "compose";
  compose?: { presetNpcIds: string[]; inviteTo?: string };
};

export type RoomAction =
  | {
      type: "list";
      rooms: RoomSummary[];
      preferRoomId: string | null;
      viewerUserId?: string | null;
    }
  | { type: "history"; roomId: string; messages: RoomMessage[] }
  | { type: "message"; roomId: string; message: RoomMessage }
  | { type: "created" | "updated"; room: RoomSummary; enter: boolean }
  | { type: "deleted"; roomId: string }
  | { type: "open"; roomId: string }
  | { type: "showList" }
  | { type: "compose"; presetNpcIds: string[]; inviteTo?: string };

export const initialRoomState: RoomState = {
  rooms: [],
  viewerUserId: null,
  currentRoomId: null,
  messages: {},
  view: "list",
};

/** The fallback room: office if present, otherwise the first room after sorting. */
function fallbackRoomId(rooms: RoomSummary[]): string | null {
  return (rooms.find((room) => room.kind === "office") ?? rooms[0])?.id ?? null;
}

export function lastRoomKey(channelId: string): string {
  return `deskrpg.lastRoom.${channelId}`;
}

export function reduceRoomState(state: RoomState, action: RoomAction): RoomState {
  switch (action.type) {
    case "list": {
      const rooms = sortRooms(action.rooms);
      const preferred = rooms.some((room) => room.id === action.preferRoomId)
        ? action.preferRoomId
        : null;
      const currentRoomId = preferred ?? fallbackRoomId(rooms);
      return {
        ...state,
        rooms,
        // Old servers do not send this value — then do not erase what we already knew.
        viewerUserId: action.viewerUserId ?? state.viewerUserId,
        currentRoomId,
        view: currentRoomId ? "room" : "list",
        compose: undefined,
      };
    }

    case "history":
      return { ...state, messages: { ...state.messages, [action.roomId]: action.messages } };

    case "message": {
      const previous = state.messages[action.roomId] ?? [];
      // There really is a path where the same message arrives twice — if the broadcast of the last line arrives right after
      // receiving the history, it is printed twice on screen.
      const existing = previous.find((message) => message.id === action.message.id);
      if (existing) {
        // If the same line comes back as a **resolved notice**, swap it in place (after registration or approval the server broadcasts
        // the line rewritten with the same id). Order and preview are not touched — it is not a new message.
        if (
          JSON.stringify(existing.notice ?? null) === JSON.stringify(action.message.notice ?? null)
        )
          return state;
        return {
          ...state,
          messages: {
            ...state.messages,
            [action.roomId]: previous.map((message) =>
              message.id === action.message.id
                ? { ...message, notice: action.message.notice }
                : message,
            ),
          },
        };
      }
      const rooms = sortRooms(
        state.rooms.map((room) =>
          room.id === action.roomId
            ? {
                ...room,
                lastMessageAt: action.message.createdAt,
                lastMessage: {
                  senderName: action.message.senderName,
                  content: action.message.content,
                  createdAt: action.message.createdAt,
                },
              }
            : room,
        ),
      );
      return {
        ...state,
        rooms,
        messages: { ...state.messages, [action.roomId]: [...previous, action.message] },
      };
    }

    case "created":
    case "updated": {
      const known = state.rooms.some((room) => room.id === action.room.id);
      const rooms = sortRooms(
        known
          ? state.rooms.map((room) => (room.id === action.room.id ? action.room : room))
          : [...state.rooms, action.room],
      );
      if (!action.enter) return { ...state, rooms };
      return { ...state, rooms, currentRoomId: action.room.id, view: "room", compose: undefined };
    }

    case "deleted": {
      const rooms = state.rooms.filter((room) => room.id !== action.roomId);
      const messages = { ...state.messages };
      delete messages[action.roomId];
      if (state.currentRoomId !== action.roomId) return { ...state, rooms, messages };
      const currentRoomId = fallbackRoomId(rooms);
      return {
        ...state,
        rooms,
        messages,
        currentRoomId,
        view: currentRoomId ? "room" : "list",
        compose: undefined,
      };
    }

    case "open":
      return { ...state, currentRoomId: action.roomId, view: "room", compose: undefined };

    case "showList":
      // Creating a new room is reachable even in a single-office channel.
      return { ...state, view: "list", compose: undefined };

    case "compose":
      return {
        ...state,
        view: "compose",
        compose: { presetNpcIds: action.presetNpcIds, inviteTo: action.inviteTo },
      };
  }
}
