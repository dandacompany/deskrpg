// GET /api/channels/:id/projects/:projectId/subprojects — registered metadata + observed unregistered tenants
// POST — register a subproject
import type { NextRequest } from "next/server";

import { listProjectSubprojects, postSubproject, type ChannelParams } from "@/lib/project-routes";

export async function GET(req: NextRequest, { params }: ChannelParams) {
  const { id, projectId } = await params;
  return listProjectSubprojects(req, id, projectId ?? "");
}

export async function POST(req: NextRequest, { params }: ChannelParams) {
  const { id, projectId } = await params;
  return postSubproject(req, id, projectId ?? "");
}
