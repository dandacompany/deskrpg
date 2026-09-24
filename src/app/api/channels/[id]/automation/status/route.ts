// GET /api/channels/:id/automation/status — summary of plugin, board, polling and in-progress work (channel members)
import type { NextRequest } from "next/server";

import { getAutomationStatus, type ChannelParams } from "@/lib/kanban-routes";

export async function GET(req: NextRequest, { params }: ChannelParams) {
  const { id } = await params;
  return getAutomationStatus(req, id);
}
