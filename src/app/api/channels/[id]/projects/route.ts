// GET /api/channels/:id/projects — project list (board metadata + our metadata + progress)
// POST — create a project (= a Hermes board)
import type { NextRequest } from "next/server";

import { listProjects, postProject, type ChannelParams } from "@/lib/project-routes";

export async function GET(req: NextRequest, { params }: ChannelParams) {
  const { id } = await params;
  return listProjects(req, id);
}

export async function POST(req: NextRequest, { params }: ChannelParams) {
  const { id } = await params;
  return postProject(req, id);
}
