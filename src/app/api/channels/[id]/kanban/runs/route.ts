// GET /api/channels/:id/kanban/runs?from=&to=&limit= — run records within the window (activity timeline)
import type { NextRequest } from "next/server";

import { listRuns, type ChannelParams } from "@/lib/kanban-routes";

export async function GET(req: NextRequest, { params }: ChannelParams) {
  const { id } = await params;
  return listRuns(req, id);
}
