import { NextRequest, NextResponse } from "next/server";

import { validateAuthSegment } from "@/lib/hermes/provider-auth-validation";
import { proxyFailure, resolveProfileRoute } from "@/lib/hermes/profile-route";

/**
 * Poll the progress of an OAuth device login.
 *
 * Tokens and account info only pass through this route — they are not logged. Owner only
 * (docs/security.md line 44). Order: segment validation → resolve (owner) → plugin call.
 */
type Ctx = {
  params: Promise<{ id: string; name: string; provider: string; sessionId: string }>;
};

export async function GET(req: NextRequest, ctx: Ctx) {
  const params = await ctx.params;
  if (!validateAuthSegment(params.provider) || !validateAuthSegment(params.sessionId)) {
    return NextResponse.json({ errorCode: "bad_request" }, { status: 400 });
  }
  const r = await resolveProfileRoute(req, params, { requireOwner: true });
  if ("error" in r) return r.error;
  const res = await r.client.pollOAuth(r.name, r.profileToken, params.provider, params.sessionId);
  if (!res.ok) return proxyFailure(res);
  return NextResponse.json(res.data);
}
