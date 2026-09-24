// GET    /api/channels/:id/kanban/attachments/:attachmentId — read an attachment
// DELETE /api/channels/:id/kanban/attachments/:attachmentId — delete an attachment
import type { NextRequest } from "next/server";

import { deleteAttachment, getAttachment, type AttachmentParams } from "@/lib/kanban-routes";

export async function GET(req: NextRequest, { params }: AttachmentParams) {
  const { id, attachmentId } = await params;
  return getAttachment(req, id, attachmentId);
}

export async function DELETE(req: NextRequest, { params }: AttachmentParams) {
  const { id, attachmentId } = await params;
  return deleteAttachment(req, id, attachmentId);
}
