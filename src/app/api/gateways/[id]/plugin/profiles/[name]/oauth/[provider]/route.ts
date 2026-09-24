import { NextRequest, NextResponse } from "next/server";

import { validateAuthSegment } from "@/lib/hermes/provider-auth-validation";
import { proxyFailure, resolveProfileRoute } from "@/lib/hermes/profile-route";

/**
 * Disconnect a profile's OAuth (delete the stored token).
 *
 * Owner only (docs/security.md line 44). Order: segment validation → resolve (owner) → plugin call.
 */
type Ctx = { params: Promise<{ id: string; name: string; provider: string }> };

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const params = await ctx.params;
  if (!validateAuthSegment(params.provider)) {
    return NextResponse.json({ errorCode: "bad_request" }, { status: 400 });
  }
  const r = await resolveProfileRoute(req, params, { requireOwner: true });
  if ("error" in r) return r.error;
  const res = await r.client.disconnectOAuth(r.name, r.profileToken, params.provider);
  if (!res.ok) return proxyFailure(res);
  return NextResponse.json(res.data);
}
