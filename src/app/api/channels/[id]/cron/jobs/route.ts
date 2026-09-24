// GET  /api/channels/:id/cron/jobs?npcId=   — union of cron jobs of the channel's active NPCs (filter by npcId)
// POST /api/channels/:id/cron/jobs          — created with the assigned NPC's profile; records the origin on success
import type { NextRequest } from "next/server";

import { createCronJob, listCronJobs, type RouteParams } from "@/lib/cron-routes";

export async function GET(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  return listCronJobs(req, id);
}

export async function POST(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  return createCronJob(req, id);
}
