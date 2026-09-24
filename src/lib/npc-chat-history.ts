// Storage for NPC 1:1 conversation history.
//
// The ownership unit for history is the **character** — exactly (character_id, npc_id) from the
// `chat_messages` schema. Even in the same channel, only I see the conversation I had with an
// NPC. The socket handler's in-memory map is just a cache in front of this store; what's left
// here is the source of truth if the process dies.

import { and, asc, eq } from "drizzle-orm";

import { summarizeDmThreads, type DmThread, type DmThreadRow } from "./dm-threads";

export type NpcHistoryRole = "player" | "npc";

export type NpcHistoryMessage = {
  /** Transient correlation IDs; retained alongside receipts until server restart. */
  id?: string;
  responseRequestId?: string;
  role: NpcHistoryRole;
  content: string;
  timestamp: number;
};

export type StoredChatMessage = {
  role: string;
  content: string;
  createdAt: Date | null;
};

export type NpcChatMessageRow = {
  characterId: string;
  npcId: string;
  role: NpcHistoryRole;
  content: string;
};

/** In-memory cache key. This one line captures the fact that it's keyed per character. */
export function npcHistoryKey(characterId: string, npcId: string): string {
  return `${characterId}:${npcId}`;
}

/**
 * Decides whose history this line should be recorded under.
 *
 * There's a window where the socket is connected and the screen looks fine, but the server's
 * `players` doesn't have an entry — right after a reconnect, before `player:join` is
 * re-established (after a deploy or network drop). Conversation exchanged during that window
 * used to vanish entirely because the server didn't know the character — the response still
 * succeeded, so the screen showed success while only the record was missing, a silent loss.
 *
 * So the client also sends its own character. But the client's claimed value isn't trusted
 * outright: if the server already knows a value (a joined socket), that wins; only when there
 * isn't one is the client's claim used, and it's flagged for ownership verification.
 */
export function pickHistoryCharacterId(input: {
  joinedCharacterId: string | null;
  claimedCharacterId: string | null;
}): { characterId: string | null; needsVerification: boolean } {
  const joined = input.joinedCharacterId?.trim();
  if (joined) return { characterId: joined, needsVerification: false };

  const claimed = input.claimedCharacterId?.trim();
  if (claimed) return { characterId: claimed, needsVerification: true };

  return { characterId: null, needsVerification: false };
}

/** null if there's nothing to store — an empty line doesn't pollute the history. */
export function buildChatMessageRow(input: {
  characterId: string;
  npcId: string;
  role: NpcHistoryRole;
  content: string;
}): NpcChatMessageRow | null {
  const content = input.content.trim();
  if (!content) return null;
  return {
    characterId: input.characterId,
    npcId: input.npcId,
    role: input.role,
    content,
  };
}

function isHistoryRole(role: string): role is NpcHistoryRole {
  return role === "player" || role === "npc";
}

/** Converts stored rows back into the history shape the client already knows. */
export function toHistoryMessages(rows: StoredChatMessage[]): NpcHistoryMessage[] {
  const messages: NpcHistoryMessage[] = [];
  for (const row of rows) {
    if (!isHistoryRole(row.role)) continue;
    messages.push({
      role: row.role,
      content: row.content,
      // A missing createdAt doesn't drop the message — the order is already decided by the
      // query, and all that's lost here is the display timestamp.
      timestamp: row.createdAt ? row.createdAt.getTime() : 0,
    });
  }
  return messages;
}

// --- DB boundary -----------------------------------------------------------
// Everything below this touches drizzle. Same injection pattern as the other server helpers —
// db·schema are taken as unknown and narrowed inside.

type ChatDb = {
  insert: (table: unknown) => { values: (row: unknown) => Promise<unknown> };
  select: (fields?: unknown) => {
    from: (table: unknown) => {
      // The selected columns differ per call (history / listing), so the row shape is narrowed by the caller.
      where: (cond: unknown) => { orderBy: (...order: unknown[]) => Promise<unknown[]> };
    };
  };
  delete: (table: unknown) => { where: (cond: unknown) => Promise<unknown> };
};

type ChatSchema = {
  chatMessages: {
    characterId: unknown;
    npcId: unknown;
    role: unknown;
    content: unknown;
    createdAt: unknown;
  };
};

function asChatDb(db: unknown): ChatDb {
  return db as ChatDb;
}

function asChatSchema(schema: unknown): ChatSchema {
  return schema as ChatSchema;
}

function ownerCondition(table: ChatSchema["chatMessages"], characterId: string, npcId: string) {
  return and(eq(table.characterId as never, characterId), eq(table.npcId as never, npcId));
}

export async function appendNpcChatMessage(
  db: unknown,
  schema: unknown,
  input: { characterId: string; npcId: string; role: NpcHistoryRole; content: string },
): Promise<NpcChatMessageRow | null> {
  const row = buildChatMessageRow(input);
  if (!row) return null;
  const { chatMessages } = asChatSchema(schema);
  await asChatDb(db).insert(chatMessages).values(row);
  return row;
}

export async function loadNpcChatHistory(
  db: unknown,
  schema: unknown,
  input: { characterId: string; npcId: string },
): Promise<NpcHistoryMessage[]> {
  const { chatMessages } = asChatSchema(schema);
  const rows = await asChatDb(db)
    .select({
      role: chatMessages.role,
      content: chatMessages.content,
      createdAt: chatMessages.createdAt,
    })
    .from(chatMessages)
    .where(ownerCondition(chatMessages, input.characterId, input.npcId))
    .orderBy(asc(chatMessages.createdAt as never));
  return toHistoryMessages(rows as StoredChatMessage[]);
}

/**
 * Pulls **one line per employee** — the last message exchanged — for every employee this
 * character has talked to; this is the DM row of the conversation list.
 *
 * Reads all of one character's DM rows and folds them in JS. Sorting by `(npcId, createdAt)`
 * rides `idx_chat_messages_lookup` directly, and the folding rule lives in `summarizeDmThreads`.
 * The row count is that one person's whole conversation with all employees, so it's the same
 * order of magnitude as `loadNpcChatHistory` (one whole employee) — it runs once per time the
 * list is opened. Switch to an aggregate query if it grows past that.
 */
export async function loadDmThreads(
  db: unknown,
  schema: unknown,
  input: { characterId: string },
): Promise<DmThread[]> {
  const { chatMessages } = asChatSchema(schema);
  const rows = await asChatDb(db)
    .select({
      npcId: chatMessages.npcId,
      role: chatMessages.role,
      content: chatMessages.content,
      createdAt: chatMessages.createdAt,
    })
    .from(chatMessages)
    .where(eq(chatMessages.characterId as never, input.characterId))
    .orderBy(asc(chatMessages.npcId as never), asc(chatMessages.createdAt as never));
  return summarizeDmThreads(rows as DmThreadRow[]);
}

export async function clearNpcChatHistory(
  db: unknown,
  schema: unknown,
  input: { characterId: string; npcId: string },
): Promise<void> {
  const { chatMessages } = asChatSchema(schema);
  await asChatDb(db)
    .delete(chatMessages)
    .where(ownerCondition(chatMessages, input.characterId, input.npcId));
}

/**
 * Confirms the character the client sent actually belongs to that user.
 * Without this check, someone else's characterId could be used to write into their history.
 */
export async function characterBelongsToUser(
  db: unknown,
  schema: unknown,
  input: { characterId: string; userId: string },
): Promise<boolean> {
  const { characters } = schema as { characters: { id: unknown; userId: unknown } };
  const rows = await (
    db as {
      select: (fields?: unknown) => {
        from: (table: unknown) => {
          where: (cond: unknown) => { limit: (n: number) => Promise<unknown[]> };
        };
      };
    }
  )
    .select({ id: characters.id })
    .from(characters)
    .where(
      and(
        eq(characters.id as never, input.characterId),
        eq(characters.userId as never, input.userId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
