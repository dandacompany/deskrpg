import { NextRequest, NextResponse } from "next/server";

import { validateAuthSegment } from "@/lib/hermes/provider-auth-validation";
import { proxyFailure, resolveProfileRoute } from "@/lib/hermes/profile-route";

/**
 * Cancel an OAuth device login in progress. The static `sessions` segment matches before its sibling
 * `oauth/[provider]`.
 *
 * Owner only (docs/security.md line 44). Order: segment validation → resolve (owner) → plugin call.
 */
type Ctx = { params: Promise<{ id: string; name: string; sessionId: string }> };

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const params = await ctx.params;
  if (!validateAuthSegment(params.sessionId)) {
    return NextResponse.json({ errorCode: "bad_request" }, { status: 400 });
  }
  const r = await resolveProfileRoute(req, params, { requireOwner: true });
  if ("error" in r) return r.error;
  const res = await r.client.cancelOAuth(r.name, r.profileToken, params.sessionId);
  if (!res.ok) return proxyFailure(res);
  return NextResponse.json(res.data);
}
