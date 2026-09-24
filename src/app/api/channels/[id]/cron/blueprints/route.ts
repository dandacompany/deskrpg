// GET /api/channels/:id/cron/blueprints?npcId= — template gallery list
import type { NextRequest } from "next/server";

import { listCronBlueprints, type RouteParams } from "@/lib/cron-routes";

export async function GET(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  return listCronBlueprints(req, id);
}
