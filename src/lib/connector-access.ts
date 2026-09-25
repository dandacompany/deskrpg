/**
 * Gatekeeper for the NPC MCP connector REST. Same order as skill management
 * (`skill-access.ts`), with its own capability: login (401) -> channel member (403/404)
 * -> gateway (409) -> automation plugin gate -> active NPC in this channel (404) ->
 * `profile_mcp_admin` (428) -> mutations require the gateway owner (403). MCP settings are
 * per-profile, so `sharedChannelCount` is reported the same way as skills.
 */
import type { NextResponse } from "next/server";

import {
  cronError,
  hasPluginCapability,
  resolveCronChannelContext,
  resolveNpcProfileClient,
  type CronChannelContext,
} from "@/lib/cron-access";
import { MCP_ADMIN_CAPABILITY, MCP_ADMIN_MIN_VERSION } from "@/lib/hermes/deskrpg-plugin-types";
import type { SkillContext } from "@/lib/skill-access";

export type ConnectorContext = SkillContext & { channel: CronChannelContext };

type Result<T> = ({ ok: true } & T) | { ok: false; response: NextResponse };

export async function resolveConnectorContext(input: {
  userId: string | null;
  channelId: string;
  npcId: string;
}): Promise<Result<{ ctx: ConnectorContext }>> {
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
      capabilityReady: await hasPluginCapability(channel.ctx, MCP_ADMIN_CAPABILITY),
      client: npc.value.client,
      gatewayId: channel.ctx.gateway.id,
      channel: channel.ctx,
    },
  };
}

export function requireMcpCapability(
  ctx: Pick<ConnectorContext, "capabilityReady">,
): NextResponse | null {
  if (ctx.capabilityReady) return null;
  return cronError(
    428,
    "plugin_upgrade_required",
    `deskrpg-hermes-plugin ${MCP_ADMIN_MIN_VERSION}+ required`,
    {
      minVersion: MCP_ADMIN_MIN_VERSION,
      missing: [MCP_ADMIN_CAPABILITY],
    },
  );
}
