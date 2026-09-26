/**
 * The `conversation:read` payload — "I have seen this conversation up to here". Client-safe (no DB),
 * so the browser builds the same shape the server accepts.
 */
export type ReadMarkKind = "room" | "dm";
export type ReadMark = { kind: ReadMarkKind; id: string; at: Date };

export const CONVERSATION_READ_EVENT = "conversation:read";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** null for anything malformed. A missing or unreadable `at` means now. */
export function parseReadMark(payload: unknown, now: Date = new Date()): ReadMark | null {
  if (!payload || typeof payload !== "object") return null;
  const { kind, id, at } = payload as { kind?: unknown; id?: unknown; at?: unknown };
  if (kind !== "room" && kind !== "dm") return null;
  if (typeof id !== "string" || !UUID.test(id)) return null;
  const parsed = typeof at === "string" ? new Date(at) : null;
  return { kind, id, at: parsed && !Number.isNaN(parsed.getTime()) ? parsed : now };
}
