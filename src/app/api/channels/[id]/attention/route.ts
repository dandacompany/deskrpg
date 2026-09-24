// GET /api/channels/:id/attention — only what a person needs to answer (channel members)
import type { NextRequest } from "next/server";

import { getAttentionInbox, type ChannelParams } from "@/lib/attention-routes";

export async function GET(req: NextRequest, { params }: ChannelParams) {
  const { id } = await params;
  return getAttentionInbox(req, id);
}
