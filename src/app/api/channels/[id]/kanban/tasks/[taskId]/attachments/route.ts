// GET  /api/channels/:id/kanban/tasks/:taskId/attachments — list
// POST /api/channels/:id/kanban/tasks/:taskId/attachments — multipart `file` passed through as is
// If the plugin does not support attachments, 404 attachments_unsupported.
import type { NextRequest } from "next/server";

import { listAttachments, uploadAttachment, type TaskParams } from "@/lib/kanban-routes";

export async function GET(req: NextRequest, { params }: TaskParams) {
  const { id, taskId } = await params;
  return listAttachments(req, id, taskId);
}

export async function POST(req: NextRequest, { params }: TaskParams) {
  const { id, taskId } = await params;
  return uploadAttachment(req, id, taskId);
}
