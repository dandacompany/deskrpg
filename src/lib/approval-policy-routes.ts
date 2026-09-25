/**
 * NPC unattended run policy REST (`/api/channels/:id/npcs/:npcId/approval-policy/**`) — the
 * profile's `approvals.cron_mode`/`single_query_mode` and `command_allowlist` through plugin
 * 0.18.0. Same gate order as connectors: login (401) -> channel member (403/404) -> gateway
 * (409) -> automation plugin gate -> active NPC in this channel (404) -> `profile_approval_policy`
 * (428, reading included) -> writes require the gateway owner (403). Every success response is
 * the policy plus the permission fields the screen needs.
 */
import { NextResponse, type NextRequest } from "next/server";

import {
  cronError,
  hasPluginCapability,
  pluginFailureResponse,
  resolveCronChannelContext,
  resolveNpcProfileClient,
} from "@/lib/cron-access";
import {
  APPROVAL_POLICY_CAPABILITY,
  APPROVAL_POLICY_MIN_VERSION,
} from "@/lib/hermes/deskrpg-plugin-types";
import type {
  ApprovalMode,
  ApprovalPolicy,
  PluginResponse,
} from "@/lib/hermes/plugin-client-types";
import { getUserId } from "@/lib/internal-rpc";
import { requireOwner, sharedChannelCount, type SkillContext } from "@/lib/skill-access";

type Params = { id: string; npcId: string; path?: string[] };

async function readBody(req: NextRequest): Promise<Record<string, unknown>> {
  if (req.method === "GET") return {};
  try {
    const parsed: unknown = await req.json();
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Passes the mode fields through as sent — the plugin rejects anything but deny/approve. */
function modesOf(body: Record<string, unknown>): {
  cronMode?: ApprovalMode;
  singleQueryMode?: ApprovalMode;
} {
  return {
    ...(body.cronMode !== undefined ? { cronMode: body.cronMode as ApprovalMode } : {}),
    ...(body.singleQueryMode !== undefined
      ? { singleQueryMode: body.singleQueryMode as ApprovalMode }
      : {}),
  };
}

export async function handleApprovalPolicyRoute(
  req: NextRequest,
  params: Params,
): Promise<Response> {
  const channel = await resolveCronChannelContext({
    userId: getUserId(req),
    channelId: params.id,
  });
  if (!channel.ok) return channel.response;
  const npc = await resolveNpcProfileClient(channel.ctx, params.npcId);
  if (!npc.ok) return npc.response;
  if (!(await hasPluginCapability(channel.ctx, APPROVAL_POLICY_CAPABILITY))) {
    return cronError(
      428,
      "plugin_upgrade_required",
      `deskrpg-hermes-plugin ${APPROVAL_POLICY_MIN_VERSION}+ required`,
      { minVersion: APPROVAL_POLICY_MIN_VERSION, missing: [APPROVAL_POLICY_CAPABILITY] },
    );
  }
  const ctx: Pick<SkillContext, "gatewayId" | "profileName" | "channelId" | "isGatewayOwner"> = {
    gatewayId: channel.ctx.gateway.id,
    profileName: npc.value.profile.profileName,
    channelId: params.id,
    isGatewayOwner: channel.ctx.gateway.ownerUserId === channel.ctx.userId,
  };
  const approvals = npc.value.client.approvals;
  const actor = channel.ctx.userId;
  const path = params.path ?? [];

  let call: (() => Promise<PluginResponse<ApprovalPolicy>>) | null = null;
  let write = true;
  if (path.length === 0 && req.method === "GET") {
    call = () => approvals.getPolicy();
    write = false;
  } else if (path.length === 0 && req.method === "PUT") {
    const body = await readBody(req);
    call = () => approvals.setModes(modesOf(body), actor);
  } else if (path.length === 1 && path[0] === "allowlist") {
    const body = await readBody(req);
    const entry = typeof body.entry === "string" ? body.entry : "";
    if (req.method === "POST") call = () => approvals.addAllowlist(entry, actor);
    if (req.method === "DELETE") call = () => approvals.removeAllowlist(entry, actor);
  }
  if (!call) return cronError(404, "not_found", "Unknown approval policy route");
  if (write) {
    const denied = requireOwner(ctx);
    if (denied) return denied;
  }

  const res = await call();
  if (!res.ok) return pluginFailureResponse(res);
  return NextResponse.json({
    ...res.data,
    canManage: ctx.isGatewayOwner,
    capabilityReady: true,
    sharedChannelCount: await sharedChannelCount(ctx),
  });
}
