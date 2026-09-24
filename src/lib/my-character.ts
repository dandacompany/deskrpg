/**
 * "My character" is one per user — this user themself (spec 2026-09-18).
 *
 * The DB may still hold old multi-character rows, so no unique constraint is enforced.
 * Instead, the **earliest character** is treated as "me" and the rest are kept only for
 * preservation. This rule lives in exactly one place — API, pages, and sockets all use
 * this function.
 */
import { asc, eq } from "drizzle-orm";

import { characters, db, jsonForDb, nowForDb } from "@/db";
import { parseDbJson } from "@/lib/db-json";
import { BIO_MAX_LENGTH } from "@/lib/my-character-limits";
import { QUICK_START_APPEARANCE, quickStartCharacterName } from "@/lib/quick-start";

export { BIO_MAX_LENGTH };

export type MyCharacter = { id: string; name: string; bio: string | null; appearance: unknown };

export async function getMyCharacter(userId: string): Promise<MyCharacter | null> {
  const [row] = await db
    .select({
      id: characters.id,
      name: characters.name,
      bio: characters.bio,
      appearance: characters.appearance,
    })
    .from(characters)
    .where(eq(characters.userId, userId))
    .orderBy(asc(characters.createdAt), asc(characters.id))
    .limit(1);
  if (!row) return null;
  return {
    ...row,
    bio: row.bio ?? null,
    appearance: parseDbJson(row.appearance) ?? row.appearance,
  };
}

export async function ensureMyCharacter(
  userId: string,
  nickname: string | null,
): Promise<MyCharacter> {
  const existing = await getMyCharacter(userId);
  if (existing) return existing;
  const [created] = await db
    .insert(characters)
    .values({
      userId,
      name: quickStartCharacterName(nickname),
      appearance: jsonForDb(QUICK_START_APPEARANCE),
      updatedAt: nowForDb(),
    })
    .returning({
      id: characters.id,
      name: characters.name,
      bio: characters.bio,
      appearance: characters.appearance,
    });
  return { ...created, bio: created.bio ?? null, appearance: QUICK_START_APPEARANCE };
}

export function isMyCharacter(mine: MyCharacter | null, characterId: string): boolean {
  return !!mine && mine.id === characterId;
}

/** Validates `bio` input — shared by POST/PATCH. Empty becomes null; over 2,000 chars is rejected. */
export function validateBio(
  value: unknown,
):
  | { ok: true; bio: string | null }
  | { ok: false; errorCode: "character_bio_too_long" | "character_bio_invalid" } {
  if (value === undefined || value === null || value === "") return { ok: true, bio: null };
  if (typeof value !== "string") return { ok: false, errorCode: "character_bio_invalid" };
  if (value.length > BIO_MAX_LENGTH) return { ok: false, errorCode: "character_bio_too_long" };
  return { ok: true, bio: value.trim() || null };
}
