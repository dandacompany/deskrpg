// PATCH /api/channels/:id/projects/:projectId/subprojects/:subprojectId
// Edits display name, status, lead and target date. The tenant slug is not accepted — Hermes cards carry that string,
// so changing it would orphan cards that already exist.
import type { NextRequest } from "next/server";

import { patchSubproject, type ChannelParams } from "@/lib/project-routes";

export async function PATCH(req: NextRequest, { params }: ChannelParams) {
  const { id, projectId, subprojectId } = await params;
  return patchSubproject(req, id, projectId ?? "", subprojectId ?? "");
}
