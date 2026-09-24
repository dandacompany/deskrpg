/**
 * The gatekeeper for the NPC skill management REST. Order: login (401) -> channel member
 * (403/404) -> gateway (409) -> automation plugin gate -> the NPC is an active NPC in
 * this channel with a current-gateway profile (404 npc_not_found) -> capability (428,
 * except for the list GET) -> mutations require the gateway owner (403).
 *
 * Skills are **per-profile**. If another channel has also hired the same profile, a
 * change applies to that channel too — the response carries `sharedChannelCount` so the
 * screen can say so.
 */
import { and, countDistinct, eq, ne } from "drizzle-orm";
import type { NextResponse } from "next/server";

import { db, hermesProfiles, npcs } from "@/db";
import { cronError, resolveCronChannelContext, resolveNpcProfileClient } from "@/lib/cron-access";
import { SKILL_ADMIN_CAPABILITY, SKILL_ADMIN_MIN_VERSION } from "@/lib/hermes/deskrpg-plugin-types";
import type { ProfilePluginClient } from "@/lib/hermes/plugin-client-types";

export type SkillContext = {
  userId: string;
  channelId: string;
  npcId: string;
  profileName: string;
  isGatewayOwner: boolean;
  capabilityReady: boolean;
  client: ProfilePluginClient;
  gatewayId: string;
};

type Result<T> = ({ ok: true } & T) | { ok: false; response: NextResponse };

export async function resolveSkillContext(input: {
  userId: string | null;
  channelId: string;
  npcId: string;
}): Promise<Result<{ ctx: SkillContext }>> {
  const channel = await resolveCronChannelContext({
    userId: input.userId,
    channelId: input.channelId,
  });
  if (!channel.ok) return channel;
  const npc = await resolveNpcProfileClient(channel.ctx, input.npcId);
  if (!npc.ok) return npc;
  return {
    ok: true,
    ctx: {
      userId: channel.ctx.userId,
      channelId: input.channelId,
      npcId: input.npcId,
      profileName: npc.value.profile.profileName,
      isGatewayOwner: channel.ctx.gateway.ownerUserId === channel.ctx.userId,
      capabilityReady: channel.ctx.info.capabilities.includes(SKILL_ADMIN_CAPABILITY),
      client: npc.value.client,
      gatewayId: channel.ctx.gateway.id,
    },
  };
}

export function requireCapability(ctx: Pick<SkillContext, "capabilityReady">): NextResponse | null {
  if (ctx.capabilityReady) return null;
  return cronError(
    428,
    "plugin_upgrade_required",
    `deskrpg-hermes-plugin ${SKILL_ADMIN_MIN_VERSION}+ required`,
    { minVersion: SKILL_ADMIN_MIN_VERSION, missing: [SKILL_ADMIN_CAPABILITY] },
  );
}

export function requireOwner(ctx: Pick<SkillContext, "isGatewayOwner">): NextResponse | null {
  return ctx.isGatewayOwner ? null : cronError(403, "forbidden", "Gateway owner only");
}

/** The number of **other** channels that have the same profile on the same gateway as an NPC (including dormant NPCs — waking one is affected immediately). */
export async function sharedChannelCount(
  ctx: Pick<SkillContext, "gatewayId" | "profileName" | "channelId">,
): Promise<number> {
  const [row] = await db
    .select({ n: countDistinct(npcs.channelId) })
    .from(npcs)
    .innerJoin(hermesProfiles, eq(hermesProfiles.id, npcs.hermesProfileId))
    .where(
      and(
        eq(hermesProfiles.gatewayId, ctx.gatewayId),
        eq(hermesProfiles.profileName, ctx.profileName),
        ne(npcs.channelId, ctx.channelId),
      ),
    );
  return Number(row?.n ?? 0);
}
