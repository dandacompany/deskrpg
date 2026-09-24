import { NextRequest, NextResponse } from "next/server";

import { db, hermesProfiles } from "@/db";
import { eq } from "drizzle-orm";
import { decryptGatewayToken, getAccessibleGatewayResource } from "@/lib/gateway-resources";
import { createPluginClient, type PluginClient } from "@/lib/hermes/plugin-client";
import { selectProfileToken, type ProfileTokenResult } from "@/lib/hermes/plugin-profile-access";
import { proxyFailureBody } from "@/lib/hermes/profile-proxy";
import type { PluginFailure } from "@/lib/hermes/plugin-errors";
import { getUserId } from "@/lib/internal-rpc";
import { ERROR_CODE_HEADER } from "@/lib/i18n/error-codes";

/**
 * Consolidates the auth/token resolution that the `/api/gateways/[id]/plugin/profiles/[name]/*` proxy routes
 * kept repeating (catalog·toolsets·skills were duplicating it verbatim). `requireOwner` is an option for the
 * credential routes moved in this batch (key PUT/DELETE,
 * OAuth start/poll/cancel/disconnect) — catalog-type routes are read-only, so
 * gateway access is enough and they still use the default (false).
 *
 * The decision order is fixed by `decideProfileRouteAccess` — 401 → gateway access (404
 * not_found) → owner (403 forbidden) → profile token (404 no_profile). Owner rejection comes
 * before the profile token lookup, so callers do not fetch the token ahead of the decision.
 */

export type ProfileRouteCtx = { params: Promise<{ id: string; name: string }> };

export type ResolvedProfileRoute = {
  client: PluginClient;
  name: string;
  profileToken: string;
  isOwner: boolean;
};

export type ProfileRouteDecision = { status: number; errorCode: string } | null;

/**
 * Pure function that pins only the decision order, without DB access. Split out so per-route scenarios
 * (not logged in / no gateway access / owner required but shared user / profile not registered / pass)
 * can be tested without a DB.
 */
export function decideProfileRouteAccess(input: {
  userId: string | null;
  accessible: { isOwner: boolean } | null;
  requireOwner: boolean;
  token: ProfileTokenResult;
}): ProfileRouteDecision {
  if (!input.userId) return { status: 401, errorCode: "unauthorized" };
  if (!input.accessible) return { status: 404, errorCode: "not_found" };
  if (input.requireOwner && !input.accessible.isOwner) {
    return { status: 403, errorCode: "forbidden" };
  }
  if (!input.token.ok) return { status: 404, errorCode: input.token.reason };
  return null;
}

export async function resolveProfileRoute(
  req: NextRequest,
  params: { id: string; name: string },
  options?: { requireOwner?: boolean },
): Promise<ResolvedProfileRoute | { error: NextResponse }> {
  const requireOwner = options?.requireOwner ?? false;
  const userId = getUserId(req);
  const { id, name } = params;

  const accessible = userId ? await getAccessibleGatewayResource(userId, id) : null;

  // Owner rejection comes before the profile token lookup. Since the token has not been fetched yet,
  // check first with the same function as the final decision, passing a failure token meaning "not looked up yet"
  // — if it yields one of 401·not_found·forbidden, there is no need to fetch the token at all.
  const notFetchedYet: ProfileTokenResult = { ok: false, reason: "no_profile" };
  const preDecision = decideProfileRouteAccess({
    userId,
    accessible: accessible ? { isOwner: accessible.isOwner } : null,
    requireOwner,
    token: notFetchedYet,
  });
  if (preDecision && preDecision.errorCode !== "no_profile") {
    return {
      error: NextResponse.json(
        { errorCode: preDecision.errorCode },
        { status: preDecision.status },
      ),
    };
  }
  // Getting here means the userId·accessible·owner checks all passed
  // (otherwise preDecision would have been one of 401/404 not_found/403).
  // accessible is now definitely non-null.
  const gatewayAccess = accessible!;

  const rows = await db
    .select({
      profileName: hermesProfiles.profileName,
      tokenEncrypted: hermesProfiles.tokenEncrypted,
    })
    .from(hermesProfiles)
    .where(eq(hermesProfiles.gatewayId, id));

  const token = selectProfileToken({ rows, profileName: name, decrypt: decryptGatewayToken });
  if (!token.ok) {
    return { error: NextResponse.json({ errorCode: token.reason }, { status: 404 }) };
  }

  const client = createPluginClient({
    baseUrl: gatewayAccess.resource.baseUrl,
    defaultToken: decryptGatewayToken(gatewayAccess.resource.tokenEncrypted),
  });
  return { client, name, profileToken: token.profileToken, isOwner: gatewayAccess.isOwner };
}

/**
 * Maps failures onto the HTTP 200 convention via `proxyFailureBody` + `ERROR_CODE_HEADER`.
 *
 * The catalog routes existed before 0.9.0, so a 404 there cannot mean "route missing"; the old-version
 * check (`isMissingPluginRoute` upgrade promotion) must not be applied. Such routes keep the existing
 * body shape with `upgradeOnMissingRoute: false` (the default is true).
 */
export function proxyFailure(
  res: { status: number; failure: PluginFailure },
  options?: { upgradeOnMissingRoute?: boolean },
): NextResponse {
  const upgradeOnMissingRoute = options?.upgradeOnMissingRoute ?? true;
  if (!upgradeOnMissingRoute) {
    return NextResponse.json(
      { errorCode: res.failure.code, error: res.failure.message, upstreamStatus: res.status },
      { status: 200, headers: { [ERROR_CODE_HEADER]: res.failure.code } },
    );
  }
  const failed = proxyFailureBody(res);
  return NextResponse.json(failed.body, {
    status: 200,
    headers: { [ERROR_CODE_HEADER]: failed.errorCode },
  });
}
