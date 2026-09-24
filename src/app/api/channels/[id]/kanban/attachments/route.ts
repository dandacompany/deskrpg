// GET /api/channels/:id/kanban/attachments?board=&cursor= — card attachments across the whole board (artifact gallery)
import type { NextRequest } from "next/server";

import { listBoardAttachments, type ChannelParams } from "@/lib/kanban-routes";

export async function GET(req: NextRequest, { params }: ChannelParams) {
  const { id } = await params;
  return listBoardAttachments(req, id);
}
