// GET    /api/channels/:id/kanban/links — parent/child pairs across the whole board (bulk read)
// POST   /api/channels/:id/kanban/links — {parent_id, child_id} add a link
// DELETE /api/channels/:id/kanban/links — {parent_id, child_id} delete a link
import type { NextRequest } from "next/server";

import { listLinks, mutateLink, type ChannelParams } from "@/lib/kanban-routes";

export async function GET(req: NextRequest, { params }: ChannelParams) {
  const { id } = await params;
  return listLinks(req, id);
}

export async function POST(req: NextRequest, { params }: ChannelParams) {
  const { id } = await params;
  return mutateLink(req, id, "add");
}

export async function DELETE(req: NextRequest, { params }: ChannelParams) {
  const { id } = await params;
  return mutateLink(req, id, "remove");
}
