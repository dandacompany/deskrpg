// POST /api/channels/:id/kanban/tasks/:taskId/comments — {body}; author is deskrpg:<nickname>
import type { NextRequest } from "next/server";

import { addComment, type TaskParams } from "@/lib/kanban-routes";

export async function POST(req: NextRequest, { params }: TaskParams) {
  const { id, taskId } = await params;
  return addComment(req, id, taskId);
}
