export type ReplyPolicy = "mention" | "members";
export type RoomRow = {
  id: string;
  channelId: string;
  kind: "office" | "group";
  name: string;
  replyPolicy: ReplyPolicy;
  createdBy: string;
  createdAt: Date;
  lastMessageAt: Date | null;
};
/**
 * One row of a room. Lives here rather than in `chat-rooms.ts` (server-only, pulls in `@/db`) —
 * the client needs this type, and even importing it from the server module with `import type`
 * trips `client-bundle-boundary.test.ts`'s import tracking.
 */
export type RoomMessage = {
  id: string;
  roomId: string;
  senderKind: "user" | "npc" | "system";
  senderId: string | null;
  senderName: string;
  content: string;
  createdAt: string;
  /** Structure for automation notices (kanban card·cron result). Absent for ordinary messages (R29·R30). */
  notice?: RoomNotice | null;
};

/**
 * Shape of `chat_room_messages.notice_json`. `content` is a locale-agnostic fallback (card
 * title·result body); everything else needed to render the card is carried here — so the
 * server doesn't hard-code Korean sentences (same principle as system messages).
 */
export type RoomNotice =
  | {
      kind: "card_done" | "card_blocked" | "card_review";
      cardId: string;
      cardTitle: string;
      boardSlug: string;
      npcName: string;
    }
  | {
      /** A pre-execution approval request (designed 2026-09-21 execution-approval-gate). The button is drawn by the renderer. */
      kind: "approval_requested";
      approvalId: string;
      title: string;
      npcName: string;
      targetCount: number;
      /** Filled once decided — the result is drawn instead of the button. Not something the client hides. */
      resolved?: { decision: string; by: string; at: string };
    }
  | {
      /**
       * A work card proposed by an NPC. Not a card yet — the user picks whether to register it
       * from the notice, and that choice is recorded in `resolved` (unset means still undecided).
       */
      kind: "card_proposal";
      proposalId: string;
      title: string;
      summary: string;
      body?: string;
      acceptance?: string;
      npcId: string;
      npcName: string;
      resolved?: { choice: "card" | "inline"; by: string; at: string; taskId?: string };
    }
  | {
      /**
       * A meeting that produced follow-up work has ended — leaves "register as a project?" in
       * the room. A meeting isn't an automation event, so it doesn't ride the event sink. Only
       * **id and count** are carried, not names (so a copy can't go stale).
       */
      kind: "meeting_outcome";
      minutesId: string;
      topic: string;
      followUpCount: number;
      recommended: boolean;
      /** Filled once registered — the result is drawn instead of the button. */
      resolved?: {
        boardSlug: string;
        tenant: string | null;
        taskCount: number;
        by: string;
        at: string;
      };
    }
  | {
      kind: "cron_result";
      jobId: string;
      jobName: string;
      npcName: string;
      status: "ok" | "error";
    };

const ROOM_NOTICE_KINDS = new Set([
  "card_done",
  "card_blocked",
  "card_review",
  "approval_requested",
  "card_proposal",
  "meeting_outcome",
  "cron_result",
]);

/** Reads back the stored JSON string. A broken value or unknown kind yields null — the message itself is still kept. */
export function parseRoomNotice(raw: string | null | undefined): RoomNotice | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const kind = (parsed as { kind?: unknown }).kind;
    return typeof kind === "string" && ROOM_NOTICE_KINDS.has(kind) ? (parsed as RoomNotice) : null;
  } catch {
    return null;
  }
}

export type RoomSummary = {
  id: string;
  kind: "office" | "group";
  name: string;
  replyPolicy: ReplyPolicy;
  createdBy: string;
  lastMessageAt: string | null;
  members: { kind: "user" | "npc"; id: string; name: string }[];
  lastMessage?: { senderName: string; content: string; createdAt: string };
};

/** Room policy × mentions → which NPCs answer this message. office(mention) is mentions only; group(members) is everyone, or the mentioned subset if any. */
export function decideResponders(
  policy: ReplyPolicy,
  mentionedIds: string[],
  memberNpcIds: string[],
): string[] {
  const members = new Set(memberNpcIds);
  const mentioned = mentionedIds.filter((id) => members.has(id));
  if (policy === "mention") return mentioned;
  return mentionedIds.length > 0 ? mentioned : [...memberNpcIds];
}

export function sortRooms(rooms: RoomSummary[]): RoomSummary[] {
  return [...rooms].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "office" ? -1 : 1;
    return (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? "");
  });
}

export type RoomAccess =
  { ok: true; room: RoomRow } | { ok: false; code: "not_found" | "forbidden" };
export function resolveRoomAccessDecision(args: {
  room: RoomRow | null;
  channelAllowed: boolean;
  isMember: boolean;
}): RoomAccess {
  if (!args.room) return { ok: false, code: "not_found" };
  if (!args.channelAllowed) return { ok: false, code: "forbidden" };
  if (args.room.kind === "group" && !args.isMember) return { ok: false, code: "forbidden" };
  return { ok: true, room: args.room };
}
