import { NextRequest, NextResponse } from "next/server";

import {
  validateAuthSegment,
  validateToolProviderBody,
} from "@/lib/hermes/provider-auth-validation";
import { proxyFailure, resolveProfileRoute } from "@/lib/hermes/profile-route";

/**
 * Choose a tool provider + save that row's API key (plugin 0.10.0).
 *
 * Key values only pass through this route — the body is not logged or put in failure responses. These are gateway
 * credentials, so it is owner only (docs/security.md permission table, same as the provider key PUT).
 * Order: segment validation → resolve (owner) → body validation → plugin call.
 */
type Ctx = { params: Promise<{ id: string; name: string; toolset: string }> };

function badRequest() {
  return NextResponse.json({ errorCode: "bad_request" }, { status: 400 });
}

export async function PUT(req: NextRequest, ctx: Ctx) {
  const params = await ctx.params;
  if (!validateAuthSegment(params.toolset)) return badRequest();
  const r = await resolveProfileRoute(req, params, { requireOwner: true });
  if ("error" in r) return r.error;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest();
  }
  const checked = validateToolProviderBody(body);
  if (!checked.ok) return NextResponse.json({ errorCode: checked.errorCode }, { status: 400 });
  const res = await r.client.putToolProvider(r.name, r.profileToken, params.toolset, {
    provider: checked.provider,
    env: checked.env,
  });
  if (!res.ok) return proxyFailure(res);
  return NextResponse.json(res.data);
}
