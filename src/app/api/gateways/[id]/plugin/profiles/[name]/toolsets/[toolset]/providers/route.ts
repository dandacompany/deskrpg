import { NextRequest, NextResponse } from "next/server";

import { validateAuthSegment } from "@/lib/hermes/provider-auth-validation";
import { proxyFailure, resolveProfileRoute } from "@/lib/hermes/profile-route";

/**
 * Relays tool provider rows (plugin 0.10.0). Read-only, so gateway access is
 * enough — key values never come, only whether they are set. Not cached (a key may have just been entered).
 */
type Ctx = { params: Promise<{ id: string; name: string; toolset: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const params = await ctx.params;
  if (!validateAuthSegment(params.toolset)) {
    return NextResponse.json({ errorCode: "bad_request" }, { status: 400 });
  }
  const r = await resolveProfileRoute(req, params);
  if ("error" in r) return r.error;
  const res = await r.client.getToolProviders(r.name, r.profileToken, params.toolset);
  if (!res.ok) return proxyFailure(res);
  return NextResponse.json(res.data);
}
