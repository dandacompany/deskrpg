// POST /api/channels/:id/kanban/tasks/:taskId/decompose — proxied as is (channel members)
import type { NextRequest } from "next/server";

import { runTaskAction, type TaskParams } from "@/lib/kanban-routes";

export async function POST(req: NextRequest, { params }: TaskParams) {
  const { id, taskId } = await params;
  return runTaskAction(req, id, taskId, "decompose");
}
