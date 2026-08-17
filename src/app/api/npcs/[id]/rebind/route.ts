import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db, hermesProfiles, npcs, channels } from "@/db";
import { getUserId } from "@/lib/internal-rpc";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = getUserId(req);
  if (!userId) {
    return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  const [npc] = await db.select().from(npcs).where(eq(npcs.id, id));
  if (!npc) {
    return NextResponse.json({ errorCode: "npc_not_found", error: "NPC not found" }, { status: 404 });
  }

  const [channel] = await db.select().from(channels).where(eq(channels.id, npc.channelId));
  if (!channel || channel.ownerId !== userId) {
    return NextResponse.json(
      { errorCode: "only_channel_owner_can_modify_npcs", error: "Only channel owner can modify NPCs" },
      { status: 403 },
    );
  }

  const body = await req.json().catch(() => ({}));
  const profileId = typeof body.profileId === "string" ? body.profileId.trim() : "";
  if (!profileId) {
    return NextResponse.json({ errorCode: "invalid_profile_id", error: "invalid_profile_id" }, { status: 400 });
  }

  const [profile] = await db.select().from(hermesProfiles).where(eq(hermesProfiles.id, profileId));
  if (!profile) {
    return NextResponse.json({ errorCode: "profile_not_found", error: "Profile not found" }, { status: 404 });
  }

  const [updated] = await db.update(npcs).set({
    hermesProfileId: profileId,
    adapterType: "hermes",
  }).where(eq(npcs.id, id)).returning();

  return NextResponse.json({ npc: updated });
}
