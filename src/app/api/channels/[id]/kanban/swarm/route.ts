// POST /api/channels/:id/kanban/swarm — build a Hermes swarm graph
import type { NextRequest } from "next/server";

import { createSwarm, type ChannelParams } from "@/lib/kanban-routes";

export async function POST(req: NextRequest, { params }: ChannelParams) {
  const { id } = await params;
  return createSwarm(req, id);
}
