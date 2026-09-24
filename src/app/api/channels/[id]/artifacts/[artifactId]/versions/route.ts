// POST /api/channels/:id/artifacts/:artifactId/versions — add a new version
import type { NextRequest } from "next/server";

import { addArtifactVersion, type ArtifactParams } from "@/lib/artifact-routes";

export async function POST(req: NextRequest, { params }: ArtifactParams) {
  const { id, artifactId } = await params;
  return addArtifactVersion(req, id, artifactId ?? "");
}
