import { NextRequest, NextResponse } from "next/server";

import { getAccessibleGatewayResource } from "@/lib/gateway-resources";
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
  const probe = await probeHermesGateway(accessible.resource.baseUrl, {
    profile: profileName,
  });
  // Do not merge the three states — "no such profile" and "the gateway is dead" are different problems.
  const status =
    probe.kind === "hermes" ? "ok" : probe.kind === "not-hermes" ? "not_found" : "unknown";
  return NextResponse.json({ status });
}
