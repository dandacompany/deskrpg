// POST /api/channels/:id/projects/:projectId/archive — archive (state transition + moving the event-receiving board)
import type { NextRequest } from "next/server";

import { postProjectArchive, type ChannelParams } from "@/lib/project-routes";

export async function POST(req: NextRequest, { params }: ChannelParams) {
  const { id, projectId } = await params;
  return postProjectArchive(req, id, projectId ?? "");
}
