// GET /api/channels/:id/kanban/events?from=&to=&limit= — card status transitions within the window (rework metric)
import type { NextRequest } from "next/server";

import { listStatusTransitions, type ChannelParams } from "@/lib/kanban-routes";

export async function GET(req: NextRequest, { params }: ChannelParams) {
  const { id } = await params;
  return listStatusTransitions(req, id);
}
