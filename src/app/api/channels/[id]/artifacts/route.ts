// GET /api/channels/:id/artifacts — the channel's artifact list
import type { NextRequest } from "next/server";

import { listArtifacts, type ArtifactParams } from "@/lib/artifact-routes";

export async function GET(req: NextRequest, { params }: ArtifactParams) {
  const { id } = await params;
  return listArtifacts(req, id);
}
