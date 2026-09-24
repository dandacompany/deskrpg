// GET   /api/channels/:id/kanban/settings — board work folder + host operation settings (visible only to channel/gateway owners)
// PATCH /api/channels/:id/kanban/settings — board (channel owner) / orchestration (gateway owner)
import type { NextRequest } from "next/server";

import { getSettings, patchSettings, type ChannelParams } from "@/lib/kanban-routes";

export async function GET(req: NextRequest, { params }: ChannelParams) {
  const { id } = await params;
  return getSettings(req, id);
}

export async function PATCH(req: NextRequest, { params }: ChannelParams) {
  const { id } = await params;
  return patchSettings(req, id);
}
