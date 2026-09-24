// GET    /api/channels/:id/kanban/tasks/:taskId — detail
// PATCH  /api/channels/:id/kanban/tasks/:taskId — partial update (one dispatch when status changes)
// DELETE /api/channels/:id/kanban/tasks/:taskId — delete
import type { NextRequest } from "next/server";

import { deleteTask, getTask, updateTask, type TaskParams } from "@/lib/kanban-routes";

export async function GET(req: NextRequest, { params }: TaskParams) {
  const { id, taskId } = await params;
  return getTask(req, id, taskId);
}

export async function PATCH(req: NextRequest, { params }: TaskParams) {
  const { id, taskId } = await params;
  return updateTask(req, id, taskId);
}

export async function DELETE(req: NextRequest, { params }: TaskParams) {
  const { id, taskId } = await params;
  return deleteTask(req, id, taskId);
}
