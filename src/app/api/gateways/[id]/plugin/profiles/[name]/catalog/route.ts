import { NextRequest, NextResponse } from "next/server";

import {
  proxyFailure,
  resolveProfileRoute,
  type ProfileRouteCtx,
} from "@/lib/hermes/profile-route";

/**
 * Relays the lists of models, providers and reasoning efforts. Read-only, so gateway access
 * is enough (unlike create/delete it does not require system_admin).
 *
 * The list is not cached. Hermes behind the plugin caches models.dev with a 20-minute TTL,
 * so caching again here would double that refresh interval — we would be breaking the
 * "always fresh" requirement.
 *
 * The resolver moved to `resolveProfileRoute` (`@/lib/hermes/profile-route`) — this route
 * predates 0.9.0, so a 404 cannot mean "no route"; the failure body keeps its existing shape (no old-version
 * verdict) with `upgradeOnMissingRoute: false`.
 * The config and identity routes are not moved this time.
 */
export async function GET(req: NextRequest, ctx: ProfileRouteCtx) {
  const r = await resolveProfileRoute(req, await ctx.params);
  if ("error" in r) return r.error;
  const res = await r.client.getCatalog(r.name, r.profileToken);
  if (!res.ok) return proxyFailure(res, { upgradeOnMissingRoute: false });
  return NextResponse.json(res.data);
}
