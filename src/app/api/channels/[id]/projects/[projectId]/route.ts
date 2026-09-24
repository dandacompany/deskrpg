// GET /api/channels/:id/projects/:projectId — detail + subprojects
// PATCH — edit metadata (name and description are delegated to Hermes)
import type { NextRequest } from "next/server";

import { getProject, patchProject, type ChannelParams } from "@/lib/project-routes";

export async function GET(req: NextRequest, { params }: ChannelParams) {
  const { id, projectId } = await params;
  return getProject(req, id, projectId ?? "");
}

export async function PATCH(req: NextRequest, { params }: ChannelParams) {
  const { id, projectId } = await params;
  return patchProject(req, id, projectId ?? "");
}
