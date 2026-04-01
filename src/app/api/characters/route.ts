import { db, jsonForDb, isPostgres } from "@/db";
import { characters } from "@/db";
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { validateAppearance } from "@/lib/lpc-registry";
import { parseDbJson } from "@/lib/db-json";

function getUserId(req: NextRequest): string | null {
  return req.headers.get("x-user-id");
}

const MAX_CHARACTERS = 5;

export async function GET(req: NextRequest) {
  const userId = getUserId(req);
  if (!userId) {
    return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });
  }

  try {
    const result = await db
      .select()
      .from(characters)
      .where(eq(characters.userId, userId))
      .orderBy(characters.createdAt);

    const parsed = isPostgres ? result : result.map((c) => ({
      ...c,
      appearance: parseDbJson(c.appearance) ?? c.appearance,
    }));
    return NextResponse.json({ characters: parsed });
  } catch (error) {
    console.error("Failed to load characters:", error);
    return NextResponse.json(
      { errorCode: "failed_to_load_character", error: "Failed to load character" },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  const userId = getUserId(req);
  if (!userId) {
    return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { name, appearance } = body;

    if (!name || !appearance) {
      return NextResponse.json(
        { errorCode: "character_name_required", error: "name and appearance are required" },
        { status: 400 },
      );
    }

    if (name.length < 1 || name.length > 50) {
      return NextResponse.json(
        { errorCode: "character_name_length_invalid", error: "name must be 1-50 characters" },
        { status: 400 },
      );
    }

    const existing = await db
      .select()
      .from(characters)
      .where(eq(characters.userId, userId));

    if (existing.length >= MAX_CHARACTERS) {
      return NextResponse.json(
        { errorCode: "max_characters_reached", error: `maximum ${MAX_CHARACTERS} characters allowed` },
        { status: 400 },
      );
    }

    const validationError = validateAppearance(appearance);
    if (validationError) {
      return NextResponse.json(
        { errorCode: "character_appearance_invalid", error: validationError },
        { status: 400 },
      );
    }

    const [character] = await db
      .insert(characters)
      .values({ userId, name, appearance: jsonForDb(appearance) })
      .returning();

    return NextResponse.json({
      character: {
        ...character,
        appearance: parseDbJson(character.appearance) ?? character.appearance,
      },
    }, { status: 201 });
  } catch (error) {
    console.error("Failed to create character:", error);
    return NextResponse.json(
      { errorCode: "failed_to_create_character", error: "Failed to create character" },
      { status: 500 },
    );
  }
}
