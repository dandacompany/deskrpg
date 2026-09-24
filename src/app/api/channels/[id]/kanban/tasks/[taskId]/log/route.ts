// GET /api/channels/:id/kanban/tasks/:taskId/log?tail= — worker log
import type { NextRequest } from "next/server";

import { getTaskLog, type TaskParams } from "@/lib/kanban-routes";

export async function GET(req: NextRequest, { params }: TaskParams) {
  const { id, taskId } = await params;
  return getTaskLog(req, id, taskId);
}
