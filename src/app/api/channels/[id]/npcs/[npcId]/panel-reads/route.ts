// GET  /api/channels/:id/npcs/:npcId/panel-reads → {cards, cron} (channel members)
// POST /api/channels/:id/npcs/:npcId/panel-reads — {tab} → 204 (channel members)
//
// The gate stops at login + channel membership. Gateway, plugin and board are checked inside the badge
// computation (`loadAssignedCardIds` → `resolveKanbanChannelContextForRead`), and if blocked there only
// the card badge becomes 0 — because the cron badge must still show on installs without the plugin.
// That branch **does not secure** a board: badge polling must not keep creating Hermes boards.
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { cronError, requireChannelMember } from "@/lib/cron-access";
import { getUserId } from "@/lib/internal-rpc";
import {
  isPanelTab,
  liveBadgeDeps,
  markTabSeen,
  readBadges,
  type PanelTarget,
} from "@/lib/npc-panel-reads";

type PanelParams = { params: Promise<{ id: string; npcId: string }> };

async function resolveTarget(
  req: NextRequest,
  params: PanelParams["params"],
): Promise<{ ok: true; target: PanelTarget } | { ok: false; response: NextResponse }> {
  const userId = getUserId(req);
  if (!userId) return { ok: false, response: cronError(401, "unauthorized", "unauthorized") };
  const { id: channelId, npcId } = await params;
  const access = await requireChannelMember(channelId, userId);
  if (!access.ok) return access;
  return { ok: true, target: { channelId, userId, npcId } };
}

export async function GET(req: NextRequest, { params }: PanelParams) {
  const resolved = await resolveTarget(req, params);
  if (!resolved.ok) return resolved.response;
  return NextResponse.json(await readBadges(resolved.target, liveBadgeDeps));
}

export async function POST(req: NextRequest, { params }: PanelParams) {
  const resolved = await resolveTarget(req, params);
  if (!resolved.ok) return resolved.response;

  const body: unknown = await req.json().catch(() => null);
  const tab = (body as { tab?: unknown } | null)?.tab;
  if (!isPanelTab(tab)) {
    return cronError(400, "invalid_body", 'tab must be "cron" or "cards"');
  }
  await markTabSeen({ ...resolved.target, tab }, liveBadgeDeps);
  return new NextResponse(null, { status: 204 });
}
