// GET /api/gateways/:id/plugin/profiles/importable — the gateway's Hermes profiles that are not
// employees yet. Gateway owner only (owner key).
import { NextRequest, NextResponse } from "next/server";

import { listImportableProfiles } from "@/lib/hermes/profile-import";
import { ERROR_CODE_HEADER } from "@/lib/i18n/error-codes";
import { getUserId } from "@/lib/internal-rpc";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = getUserId(req);
  if (!userId) {
    return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const result = await listImportableProfiles(userId, id);
  if (!result.ok) {
    // Upstream failures ride on 200 + header (Cloudflare replaces 5xx bodies — see plugin/profiles/route.ts).
    return NextResponse.json(
      { errorCode: result.errorCode, error: result.errorCode },
      result.upstream
        ? { status: 200, headers: { [ERROR_CODE_HEADER]: result.errorCode } }
        : { status: result.status },
    );
  }
  return NextResponse.json({ profiles: result.profiles });
}
