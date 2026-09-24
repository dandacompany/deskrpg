// GET /api/channels/:id/cron/jobs/:jobId/runs?npcId=&limit= — run history
import type { NextRequest } from "next/server";

import { listCronJobRuns } from "@/lib/cron-routes";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; jobId: string }> },
) {
  const { id, jobId } = await params;
  return listCronJobRuns(req, id, jobId);
}
