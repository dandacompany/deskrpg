/**
 * NPC unattended run policy REST (`/api/channels/:id/npcs/:npcId/approval-policy/**`) — the
 * profile's `approvals.cron_mode`/`single_query_mode` and `command_allowlist` through plugin
 * 0.18.0. Same gate order as connectors: login (401) -> channel member (403/404) -> gateway
 * (409) -> automation plugin gate -> active NPC in this channel (404) -> `profile_approval_policy`
 * (428, reading included) -> writes require the gateway owner (403). Every success response is
 * the policy plus the permission fields the screen needs.
 */
import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { chatRoomMessages, chatRooms, db } from "@/db";
import { requestEmitRoomMessage } from "@/lib/automation-registry";
import { parseRoomNotice, type RoomNotice } from "@/lib/chat-rooms-policy";

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

/**
 * Records on the blocked-run notice the owner acted from that its rule is now allowed, so the attention row
 * goes away and the notice shows what unblocked it. Only an `approval_blocked` notice in this channel's office
 * room, addressed to the requester (or the requester owns the gateway). Otherwise nothing changes — the
 * allowlist change itself already succeeded.
 */
async function resolveBlockedNotice(input: {
  channelId: string;
  messageId: string;
  entry: string;
  userId: string;
  isGatewayOwner: boolean;
}): Promise<void> {
  const [row] = await db
    .select({ message: chatRoomMessages })
    .from(chatRoomMessages)
    .innerJoin(chatRooms, eq(chatRooms.id, chatRoomMessages.roomId))
    .where(
      and(
        eq(chatRoomMessages.id, input.messageId),
        eq(chatRooms.channelId, input.channelId),
        eq(chatRooms.kind, "office"),
      ),
    )
    .limit(1);
  const notice = parseRoomNotice(row?.message.noticeJson);
  if (!row || notice?.kind !== "approval_blocked" || notice.resolved) return;
  if (notice.audience !== input.userId && !input.isGatewayOwner) return;
  const next: RoomNotice = {
    ...notice,
    resolved: { allowlisted: input.entry, by: input.userId, at: new Date().toISOString() },
  };
  await db
    .update(chatRoomMessages)
    .set({ noticeJson: JSON.stringify(next) })
    .where(eq(chatRoomMessages.id, row.message.id));
  const m = row.message;
  requestEmitRoomMessage(m.roomId, {
    id: m.id,
    roomId: m.roomId,
    senderKind: m.senderKind,
    senderId: m.senderId,
    senderName: m.senderName,
    content: m.content,
    createdAt: m.createdAt instanceof Date ? m.createdAt.toISOString() : String(m.createdAt),
    notice: next,
  });
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
  let resolveNotice: { messageId: string; entry: string } | null = null;
  if (path.length === 0 && req.method === "GET") {
    call = () => approvals.getPolicy();
    write = false;
  } else if (path.length === 0 && req.method === "PUT") {
    const body = await readBody(req);
    call = () => approvals.setModes(modesOf(body), actor);
  } else if (path.length === 1 && path[0] === "allowlist") {
    const body = await readBody(req);
    const entry = typeof body.entry === "string" ? body.entry : "";
    if (req.method === "POST") {
      call = () => approvals.addAllowlist(entry, actor);
      // Optional: the blocked-run notice the owner acted from (the attention row's id).
      if (typeof body.noticeMessageId === "string" && body.noticeMessageId)
        resolveNotice = { messageId: body.noticeMessageId, entry };
    }
    if (req.method === "DELETE") call = () => approvals.removeAllowlist(entry, actor);
  }
  if (!call) return cronError(404, "not_found", "Unknown approval policy route");
  if (write) {
    const denied = requireOwner(ctx);
    if (denied) return denied;
  }

  const res = await call();
  if (!res.ok) return pluginFailureResponse(res);
  if (resolveNotice) {
    await resolveBlockedNotice({
      channelId: params.id,
      ...resolveNotice,
      userId: actor,
      isGatewayOwner: ctx.isGatewayOwner,
    }).catch((err: unknown) =>
      console.warn("[approval-policy] failed to mark the blocked-run notice resolved", err),
    );
  }
  return NextResponse.json({
    ...res.data,
    canManage: ctx.isGatewayOwner,
    capabilityReady: true,
    sharedChannelCount: await sharedChannelCount(ctx),
  });
}
