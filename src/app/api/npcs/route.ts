import { deriveChannelMotionLayout } from "@/lib/channel-motion-layout";
import { isCreativeStudioMap } from "@/lib/effective-map-spawn";
// There is no NPC creation route. NPCs are not made by users but are "the seat a gateway's profile
// holds in a channel", and those seats are made by gateway connection (hireGatewayProfilesIntoChannel) and
// profile registration (hireProfileIntoBoundChannels). If they could be made again here,
// NPCs without profiles or duplicate seats would appear.
import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db, channelMembers, channels } from "@/db";
import { getUserId } from "@/lib/internal-rpc";
import { getGatewayRuntimeStateForChannel } from "@/lib/gateway-resources";
import { selectChannelNpcs } from "@/lib/npc-projection";
import { channelSeats } from "@/lib/npc-seating";
import { seatNumberAt } from "@/lib/seat-assignment";
import { resolveChannelMemberAccess } from "@/lib/channel-membership";

export async function GET(req: NextRequest) {
  try {
    // For a long time this route only checked login and not channel membership. Once `roster=1`
    // started carrying the profile's owner and gateway, anyone knowing a channel UUID could read someone else's office
    // roster. Apply the same boundary the minutes route uses.
    const userId = getUserId(req);
    if (!userId) {
      return NextResponse.json(
        { errorCode: "unauthorized", error: "unauthorized" },
        { status: 401 },
      );
    }

    const channelId = req.nextUrl.searchParams.get("channelId");
    // roster=1 is the "hiring roster" — it also includes NPCs that have no seat yet or have clocked out.
    // The default response (for the map) returns only placed, clocked-in ones as before.
    const roster = req.nextUrl.searchParams.get("roster") === "1";
    if (!channelId) {
      // Without channelId this used to return the NPCs of all channels wholesale. A path with no
      // callers at all, and a response leaking across channel boundaries.
      return NextResponse.json(
        { errorCode: "channel_id_required", error: "channelId required" },
        { status: 400 },
      );
    }

    const access = await resolveChannelMemberAccess({
      userId,
      channelId,
      deps: {
        loadChannelOwner: async (id) => {
          const [channel] = await db
            .select({ ownerId: channels.ownerId })
            .from(channels)
            .where(eq(channels.id, id))
            .limit(1);
          return channel?.ownerId ?? null;
        },
        loadMembership: async (id, uid) => {
          const [member] = await db
            .select({ role: channelMembers.role })
            .from(channelMembers)
            .where(and(eq(channelMembers.channelId, id), eq(channelMembers.userId, uid)))
            .limit(1);
          return Boolean(member);
        },
      },
    });
    if (!access.ok) {
      return NextResponse.json(
        { errorCode: access.errorCode, error: access.error },
        { status: access.status },
      );
    }

    const gatewayState = await getGatewayRuntimeStateForChannel(channelId, {
      forceRefresh: true,
    });
    if (gatewayState.status !== "valid") {
      return NextResponse.json({ npcs: [] });
    }

    const list = await selectChannelNpcs(channelId, { roster });
    // The roster must show seat numbers on the "hiring roster" screen — the default map response does not need to
    // compute seats, so read the channel map once more only here.
    const seats = roster ? await channelSeats(channelId) : null;
    const [mapChannel] = !roster
      ? await db
          .select({ mapData: channels.mapData })
          .from(channels)
          .where(eq(channels.id, channelId))
          .limit(1)
      : [];
    const runtimeHomes =
      mapChannel && isCreativeStudioMap(mapChannel.mapData)
        ? deriveChannelMotionLayout(
            mapChannel,
            list
              .filter((npc) => npc.positionX !== null && npc.positionY !== null)
              .map((npc) => ({ id: npc.id, positionX: npc.positionX!, positionY: npc.positionY! })),
          )?.npcs
        : undefined;
    const result = list.map((npc) => {
      const home = runtimeHomes?.find((home) => home.id === npc.id);
      const agentConfig = (npc.agentConfig ?? {}) as Record<string, unknown>;
      return {
        id: npc.id,
        name: npc.name,
        positionX: home ? Math.floor(home.x / 32) : npc.positionX,
        positionY: home ? Math.floor(home.y / 32) : npc.positionY,
        direction: npc.direction,
        appearance: npc.appearance,
        hasAgent: !!agentConfig.agentId,
        agentId: (agentConfig.agentId as string) || null,
        adapterType: npc.adapterType,
        hermesProfileId: npc.hermesProfileId,
        ...(roster
          ? {
              active: npc.active,
              placed: npc.positionX !== null,
              profile: npc.profile,
              seatNumber: seats ? seatNumberAt(seats, npc.positionX, npc.positionY) : null,
            }
          : {}),
      };
    });
    return NextResponse.json({ npcs: result });
  } catch (err) {
    console.error("Failed to fetch NPCs:", err);
    return NextResponse.json(
      { errorCode: "failed_to_fetch_npcs", error: "Failed to fetch NPCs" },
      { status: 500 },
    );
  }
}
