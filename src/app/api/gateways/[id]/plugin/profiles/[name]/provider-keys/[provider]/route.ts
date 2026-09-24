import { NextRequest, NextResponse } from "next/server";

import { validateAuthSegment, validateKeyBody } from "@/lib/hermes/provider-auth-validation";
import { proxyFailure, resolveProfileRoute } from "@/lib/hermes/profile-route";

/**
 * Save (PUT) or delete (DELETE) a profile's provider API key.
 *
 * Key values only pass through this route — the body is not logged, and the request body is not mixed
 * into failure responses. Owner only (docs/security.md line 44 — gateway credentials are owner-only).
 * Order: segment validation → resolve (owner) → body validation → plugin call.
 */
type Ctx = { params: Promise<{ id: string; name: string; provider: string }> };

function badRequest() {
  return NextResponse.json({ errorCode: "bad_request" }, { status: 400 });
}

export async function PUT(req: NextRequest, ctx: Ctx) {
  const params = await ctx.params;
  if (!validateAuthSegment(params.provider)) return badRequest();
  const r = await resolveProfileRoute(req, params, { requireOwner: true });
  if ("error" in r) return r.error;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest();
  }
  const checked = validateKeyBody(body);
  if (!checked.ok) return NextResponse.json({ errorCode: checked.errorCode }, { status: 400 });
  const res = await r.client.putProviderKey(r.name, r.profileToken, params.provider, checked.value);
  if (!res.ok) return proxyFailure(res);
  return NextResponse.json(res.data);
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const params = await ctx.params;
  if (!validateAuthSegment(params.provider)) return badRequest();
  const r = await resolveProfileRoute(req, params, { requireOwner: true });
  if ("error" in r) return r.error;
  const res = await r.client.deleteProviderKey(r.name, r.profileToken, params.provider);
  if (!res.ok) return proxyFailure(res);
  return NextResponse.json(res.data);
}
