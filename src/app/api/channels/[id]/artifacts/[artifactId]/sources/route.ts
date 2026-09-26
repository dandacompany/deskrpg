// GET /api/channels/:id/artifacts/:artifactId/sources — what the session that made the artifact read.
import type { NextRequest } from "next/server";

import { getArtifactSources, type ArtifactParams } from "@/lib/artifact-routes";

export async function GET(req: NextRequest, { params }: ArtifactParams) {
  const { id, artifactId } = await params;
  return getArtifactSources(req, id, artifactId ?? "");
}
