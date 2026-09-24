// POST /api/channels/:id/cron/jobs/:jobId/run — {npcId} (origin channel members only)
import type { NextRequest } from "next/server";

import { mutateFromBody } from "@/lib/cron-routes";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; jobId: string }> },
) {
  const { id, jobId } = await params;
  return mutateFromBody(req, id, jobId, { kind: "run" });
}
