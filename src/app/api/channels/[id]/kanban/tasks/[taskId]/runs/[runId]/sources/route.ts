// GET /api/channels/:id/kanban/tasks/:taskId/runs/:runId/sources — what that run's worker session read
import type { NextRequest } from "next/server";

import { getRunSources, type RunParams } from "@/lib/kanban-routes";

export async function GET(req: NextRequest, { params }: RunParams) {
  const { id, taskId, runId } = await params;
  return getRunSources(req, id, taskId, runId);
}
