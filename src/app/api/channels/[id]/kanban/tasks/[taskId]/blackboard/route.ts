// GET /api/channels/:id/kanban/tasks/:taskId/blackboard — the swarm root's shared blackboard
import type { NextRequest } from "next/server";

import { getBlackboard, type TaskParams } from "@/lib/kanban-routes";

export async function GET(req: NextRequest, { params }: TaskParams) {
  const { id, taskId } = await params;
  return getBlackboard(req, id, taskId);
}
