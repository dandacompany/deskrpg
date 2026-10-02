import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db, hermesProfiles } from "@/db";
import {
  getAccessibleGatewayResource,
  resolveGatewayToken,
} from "@/lib/gateway-resources";
import { probeHermesGateway } from "@/lib/hermes/gateway-probe";
import { isValidProfileName } from "@/lib/hermes/profile-name";
import { getUserId } from "@/lib/internal-rpc";

// The single source of truth for name grammar is @/lib/hermes/profile-name (final review I2).
//
// Passing it to the probe unvalidated is dangerous: encodeURIComponent does not escape "."
// so ".." survives as a path segment, and URL normalization folds `/p/../health` into
// `/health`. Then the gateway root health returns 200, and "확인됨" shows for a profile
// that does not exist.

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = getUserId(req);
  if (!userId) {
    return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const accessible = await getAccessibleGatewayResource(userId, id);
  if (!accessible) {
    return NextResponse.json(
      { errorCode: "gateway_not_found", error: "Gateway not found" },
      { status: 404 },
    );
  }

  // Token decryption failure must fail closed without making any outbound requests.
  const gatewayTokenResolved = resolveGatewayToken(accessible.resource.tokenEncrypted);
  if (!gatewayTokenResolved.ok) {
    return NextResponse.json({ status: "unknown" });
  }

  const body = await req.json().catch(() => ({}));
  const profileName = typeof body?.profileName === "string" ? body.profileName.trim() : "";
  if (!profileName) {
    return NextResponse.json({ status: "unknown" });
  }
  // Apply the name rules before probing the gateway — if they fail, fetch is never
  // called at all.
  if (!isValidProfileName(profileName)) {
    return NextResponse.json({ status: "not_found" });
  }

  // Resolve the credential scope for this profile:
  // 1. "default" profile uses the gateway listener-owner key.
  // 2. Named profiles use an explicitly supplied token from request body (if provided)
  //    or the stored profile token from hermesProfiles data model.
  // 3. Never send the gateway listener-owner key to a secondary profile's /p/<profile>/v1/models.
  let profileToken: string | undefined;
  if (profileName === "default") {
    profileToken = gatewayTokenResolved.token;
  } else if (typeof body?.token === "string" && body.token.trim()) {
    profileToken = body.token.trim();
  } else {
    const [existingProfile] = await db
      .select({ tokenEncrypted: hermesProfiles.tokenEncrypted })
      .from(hermesProfiles)
      .where(
        and(
          eq(hermesProfiles.gatewayId, id),
          eq(hermesProfiles.profileName, profileName),
        ),
      )
      .limit(1);
    if (existingProfile) {
      const resolvedProfileToken = resolveGatewayToken(existingProfile.tokenEncrypted);
      if (!resolvedProfileToken.ok) {
        return NextResponse.json({ status: "unknown" });
      }
      profileToken = resolvedProfileToken.token;
    }
  }

  // If a profile-scoped credential is available (or default), probe with profile scope and token.
  // Otherwise, use an unscoped gateway identification probe with honest semantics:
  // verify the gateway itself is reachable, but do not claim profile validation without credentials.
  if (profileName === "default" || profileToken) {
    const probe = await probeHermesGateway(accessible.resource.baseUrl, {
      profile: profileName,
      token: profileToken,
    });
    const status =
      probe.kind === "hermes" ? "ok" : probe.kind === "not-hermes" ? "not_found" : "unknown";
    return NextResponse.json({ status });
  }

  // Unscoped identification probe using owner key — does not hit /p/<profile>/v1/models unauthenticated.
  const probe = await probeHermesGateway(accessible.resource.baseUrl, {
    token: gatewayTokenResolved.token,
  });
  if (probe.kind !== "hermes") {
    return NextResponse.json({ status: "unknown" });
  }
  // Gateway is verified, but profile authentication cannot be established without profile credentials.
  return NextResponse.json({ status: "unknown" });
}
