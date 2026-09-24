// GET /api/channels/:id/cron/delivery-targets?npcId= — that profile's delivery targets
import type { NextRequest } from "next/server";

import { listCronDeliveryTargets, type RouteParams } from "@/lib/cron-routes";

export async function GET(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  return listCronDeliveryTargets(req, id);
}
