// POST /api/channels/:id/kanban/tasks — create a card (assignee is npcId), then one dispatch right after
import type { NextRequest } from "next/server";

import { createTask, type ChannelParams } from "@/lib/kanban-routes";

export async function POST(req: NextRequest, { params }: ChannelParams) {
  const { id } = await params;
  return createTask(req, id);
}
