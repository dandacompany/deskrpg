import { NextRequest, NextResponse } from "next/server";

import {
  proxyFailure,
  resolveProfileRoute,
  type ProfileRouteCtx,
} from "@/lib/hermes/profile-route";

/**
 * Relays the skill list. Read-only, so gateway access is enough.
 * The list is not cached — the user may have just changed whether keys are set.
 *
 * The resolver moved to `resolveProfileRoute` (`@/lib/hermes/profile-route`).
 */
export async function GET(req: NextRequest, ctx: ProfileRouteCtx) {
  const r = await resolveProfileRoute(req, await ctx.params);
  if ("error" in r) return r.error;
  const res = await r.client.getSkills(r.name, r.profileToken);
  if (!res.ok) return proxyFailure(res);
  return NextResponse.json(res.data);
}
