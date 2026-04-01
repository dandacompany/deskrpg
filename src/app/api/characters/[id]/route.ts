import { db, jsonForDb, isPostgres } from "@/db";
import { characters, channels } from "@/db";
import { NextRequest, NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { validateAppearance } from "@/lib/lpc-registry";
import { parseDbJson } from "@/lib/db-json";

function getUserId(req: NextRequest): string | null {
  return req.headers.get("x-user-id");
}

// GET /api/characters/:id — get single character
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = getUserId(req);
  if (!userId) {
    return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  try {
    const [character] = await db
      .select()
      .from(characters)
      .where(and(eq(characters.id, id), eq(characters.userId, userId)))
      .limit(1);

    if (!character) {
      return NextResponse.json(
        { errorCode: "character_not_found", error: "character not found" },
        { status: 404 },
      );
    }

    const parsed = !isPostgres
      ? { ...character, appearance: parseDbJson(character.appearance) ?? character.appearance }
      : character;
    return NextResponse.json({ character: parsed });
  } catch (error) {
    console.error("Failed to load character:", error);
    return NextResponse.json(
      { errorCode: "failed_to_load_character", error: "Failed to load character" },
      { status: 500 },
    );
  }
}

// PATCH /api/characters/:id — update character name and/or appearance
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = getUserId(req);
  if (!userId) {
    return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  try {
    const body = await req.json();
    const { name, appearance } = body;

    // Verify ownership
    const [existing] = await db
      .select()
      .from(characters)
      .where(and(eq(characters.id, id), eq(characters.userId, userId)))
      .limit(1);

    if (!existing) {
      return NextResponse.json(
        { errorCode: "character_not_found", error: "character not found" },
        { status: 404 },
      );
    }

    const updates: Record<string, unknown> = { updatedAt: (isPostgres ? new Date() : new Date().toISOString()) as unknown as Date };

    if (name !== undefined) {
      if (typeof name !== "string" || name.length < 1 || name.length > 50) {
        return NextResponse.json(
          { errorCode: "character_name_length_invalid", error: "name must be 1-50 characters" },
          { status: 400 },
        );
      }
      updates.name = name;
    }

    if (appearance !== undefined) {
      const validationError = validateAppearance(appearance);
      if (validationError) {
        return NextResponse.json(
          { errorCode: "character_appearance_invalid", error: validationError },
          { status: 400 },
        );
      }
      updates.appearance = jsonForDb(appearance);
    }

    const [updated] = await db
      .update(characters)
      .set(updates)
      .where(eq(characters.id, id))
      .returning();

    return NextResponse.json({
      character: {
        ...updated,
        appearance: parseDbJson(updated.appearance) ?? updated.appearance,
      },
    });
  } catch (error) {
    console.error("Failed to update character:", error);
    return NextResponse.json(
      { errorCode: "failed_to_update_character", error: "Failed to update character" },
      { status: 500 },
    );
  }
}

// DELETE /api/characters/:id — delete character
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = getUserId(req);
  if (!userId) {
    return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  try {
    const [existing] = await db
      .select()
      .from(characters)
      .where(and(eq(characters.id, id), eq(characters.userId, userId)))
      .limit(1);

    if (!existing) {
      return NextResponse.json(
        { errorCode: "character_not_found", error: "character not found" },
        { status: 404 },
      );
    }

    // Delete channels owned by this user (CASCADE handles npcs, members, chat_messages)
    await db.delete(channels).where(eq(channels.ownerId, userId));

    // Delete the character
    await db.delete(characters).where(eq(characters.id, id));

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Failed to delete character:", error);
    return NextResponse.json(
      { errorCode: "failed_to_update_character", error: "Failed to update character" },
      { status: 500 },
    );
  }
}
