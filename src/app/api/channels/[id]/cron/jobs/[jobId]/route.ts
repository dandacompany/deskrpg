// GET    /api/channels/:id/cron/jobs/:jobId?npcId=  — detail
// PUT    /api/channels/:id/cron/jobs/:jobId         — {npcId, updates} (origin channel members only)
// DELETE /api/channels/:id/cron/jobs/:jobId?npcId=  — delete + remove origin (origin channel members only)
import type { NextRequest } from "next/server";

import { getCronJob, mutateCronJob, parseUpdateBody, readNpcIdParam } from "@/lib/cron-routes";
import { cronError } from "@/lib/cron-access";
import { readJsonObject } from "@/lib/api-body";

type JobParams = { params: Promise<{ id: string; jobId: string }> };

export async function GET(req: NextRequest, { params }: JobParams) {
  const { id, jobId } = await params;
  return getCronJob(req, id, jobId);
}

export async function PUT(req: NextRequest, { params }: JobParams) {
  const { id, jobId } = await params;
  const body = await readJsonObject(req);
  if (!body) return cronError(400, "invalid_body", "JSON body required");
  const parsed = parseUpdateBody(body);
  if (!parsed.ok) return parsed.response;
  return mutateCronJob(req, id, jobId, parsed.npcId, { kind: "update", update: parsed.update });
}

export async function DELETE(req: NextRequest, { params }: JobParams) {
  const { id, jobId } = await params;
  return mutateCronJob(req, id, jobId, readNpcIdParam(req), { kind: "delete" });
}
