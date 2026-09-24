// POST /api/channels/:id/kanban/tasks/:taskId/approve — review → done (channel members)
import type { NextRequest } from "next/server";

import { runTaskAction, type TaskParams } from "@/lib/kanban-routes";

export async function POST(req: NextRequest, { params }: TaskParams) {
  const { id, taskId } = await params;
  return runTaskAction(req, id, taskId, "approve");
}
