import { NextRequest, NextResponse } from "next/server";

import { db, hermesProfiles } from "@/db";
import { eq } from "drizzle-orm";

import { getAccessibleGatewayResource } from "@/lib/gateway-resources";
import { deleteHermesProfile, profileUsage, updateHermesProfile } from "@/lib/hermes-profiles";
import { getUserId } from "@/lib/internal-rpc";
import {
  normalizeOfficeAppearance,
  validateOfficeAppearance,
} from "@/game/three/office-appearance";

/**
 * Read, edit and delete a profile.
 *
 * Without edit and delete, a profile with a wrongly entered token could not be touched from the screen —
 * a dead end where you could only create, never fix or remove.
 */

/** Provide counts so the delete confirmation can say "NPC 2개 · 채널 2곳이 사라집니다". */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; profileId: string }> },
) {
  const userId = getUserId(req);
  if (!userId) {
    return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });
  }
  const { id, profileId } = await params;
  // Counts are visible only to those with gateway access too — there is no reason to reveal how many
  // of someone else's personas are out in which channels.
  if (!(await getAccessibleGatewayResource(userId, id))) {
    return NextResponse.json({ errorCode: "not_found", error: "not found" }, { status: 404 });
  }
  // Check that the gateway and profile in the URL really belong together — having access to just one
  // gateway must not let you pry out counts for profiles of someone else's gateway
  // (PATCH and DELETE already check this inside updateHermesProfile/deleteHermesProfile).
  const [row] = await db
    .select({ gatewayId: hermesProfiles.gatewayId })
    .from(hermesProfiles)
    .where(eq(hermesProfiles.id, profileId))
    .limit(1);
  if (!row || row.gatewayId !== id) {
    return NextResponse.json(
      { errorCode: "profile_not_found", error: "profile_not_found" },
      { status: 404 },
    );
  }
  return NextResponse.json({ usage: await profileUsage(profileId) });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ profileId: string }> },
) {
  const userId = getUserId(req);
  if (!userId) {
    return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });
  }
  const { profileId } = await params;

  const body = (await req.json().catch(() => ({}))) as {
    token?: unknown;
    displayName?: unknown;
    appearance?: unknown;
  };

  // The profile is the source of truth for appearance, so it governs rendering in **every** channel this profile
  // is out in at once — a malformed value breaks all of that persona simultaneously.
  // Uses the same validation and error code as the character route (api/characters).
  if (Object.hasOwn(body, "appearance")) {
    const validationError = validateOfficeAppearance(body.appearance);
    if (validationError) {
      return NextResponse.json(
        { errorCode: "character_appearance_invalid", error: validationError },
        { status: 400 },
      );
    }
  }

  const result = await updateHermesProfile(userId, profileId, {
    // The token changes only when sent — the convention is that the screen never sends an empty field.
    token: typeof body.token === "string" ? body.token : undefined,
    displayName: typeof body.displayName === "string" ? body.displayName : undefined,
    // Appearance also changes only when sent. Only the owner can write it (updateHermesProfile decides).
    appearance: Object.hasOwn(body, "appearance")
      ? normalizeOfficeAppearance(body.appearance)
      : undefined,
  });

  if (!result.ok) {
    return NextResponse.json(
      { errorCode: result.errorCode, error: result.errorCode },
      { status: result.errorCode === "forbidden" ? 403 : 404 },
    );
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ profileId: string }> },
) {
  const userId = getUserId(req);
  if (!userId) {
    return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });
  }
  const { profileId } = await params;

  const result = await deleteHermesProfile(userId, profileId);
  if (!result.ok) {
    return NextResponse.json(
      { errorCode: result.errorCode, error: result.errorCode },
      { status: result.errorCode === "forbidden" ? 403 : 404 },
    );
  }
  // Deleting the profile also removes its NPC rows via CASCADE — return how many disappeared
  // from how many channels.
  return NextResponse.json({
    ok: true,
    deletedNpcs: result.deletedNpcs,
    channels: result.channels,
  });
}
