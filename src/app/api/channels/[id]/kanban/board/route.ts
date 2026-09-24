// GET /api/channels/:id/kanban/board?include_archived= — board + NPC roster (for mapping assignee → npc)
import type { NextRequest } from "next/server";

import { getBoard, type ChannelParams } from "@/lib/kanban-routes";

export async function GET(req: NextRequest, { params }: ChannelParams) {
  const { id } = await params;
  return getBoard(req, id);
}
