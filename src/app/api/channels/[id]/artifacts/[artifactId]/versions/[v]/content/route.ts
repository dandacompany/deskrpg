// GET /api/channels/:id/artifacts/:artifactId/versions/:v/content — raw artifact stream (Range supported)
import type { NextRequest } from "next/server";

import { getArtifactContent, type ArtifactParams } from "@/lib/artifact-routes";

export async function GET(req: NextRequest, { params }: ArtifactParams) {
  const { id, artifactId, v } = await params;
  return getArtifactContent(req, id, artifactId ?? "", v ?? "");
}
