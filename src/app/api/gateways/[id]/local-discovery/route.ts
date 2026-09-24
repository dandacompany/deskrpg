import { NextRequest, NextResponse } from "next/server";
import { homedir } from "node:os";

import { eq } from "drizzle-orm";

import { db, gatewayResources, nowForDb } from "@/db";
import { getAccessibleGatewayResource } from "@/lib/gateway-resources";
import { probeHermesGateway } from "@/lib/hermes/gateway-probe";
import { localDiscoveryAllowed } from "@/lib/hermes/local-discovery-gate";
import { discoverLocalProfiles } from "@/lib/hermes/local-discovery";
import {
  listLocalProfiles,
  nodeProfileFs,
  readProfileToken,
  resolveProfilesRoot,
} from "@/lib/hermes/local-profiles";
import { listHermesProfiles, registerHermesProfile } from "@/lib/hermes-profiles";
import { getUserId } from "@/lib/internal-rpc";

import { isValidProfileName } from "../profiles/validation";

/** Do not touch the filesystem before opt-in. */
function optedIn(resource: { localDiscoveryOptedInAt?: string | Date | null }) {
  return !!resource.localDiscoveryOptedInAt;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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

  // Spec §4 step 1 + the instance-level switch (final review C1). If either is missing, we neither
  // build filesystem paths nor check their existence. The feature appears absent rather than
  // erroring — the same shape as a container without a profile root.
  if (
    !localDiscoveryAllowed({
      env: process.env,
      baseUrl: accessible.resource.baseUrl,
    })
  ) {
    return NextResponse.json({
      available: false,
      optedIn: false,
      candidates: [],
    });
  }

  const root = resolveProfilesRoot(process.env, homedir());
  const fs = nodeProfileFs();
  // Capability check (spec §4 step 2): does the root actually exist. Even if the URL is 127.0.0.1,
  // it does not exist inside a container.
  const available = fs.existsSync(root);

  if (!optedIn(accessible.resource)) {
    return NextResponse.json({ available, optedIn: false, candidates: [] });
  }

  // Opt-in is the owner's consent — its scope is not extended to users who received a share.
  // Profile directory names on the owner's machine (and whether they hold tokens) partially expose
  // filesystem contents, so this mirrors POST already being owner-only
  // (Task 4 review, Important 1).
  if (!accessible.isOwner) {
    return NextResponse.json({ available, optedIn: true, candidates: [] });
  }

  const registered = await listHermesProfiles(userId, id);
  const candidates = await discoverLocalProfiles({
    baseUrl: accessible.resource.baseUrl,
    localProfiles: listLocalProfiles(root, fs),
    registeredNames: registered.map((r) => r.profileName),
    probe: async (baseUrl, profile) => {
      const { kind } = await probeHermesGateway(baseUrl, { profile });
      // What local discovery asks is "is this profile on this gateway".
      // If the address is not an API Server (a dashboard, etc.) there is no point discussing profiles,
      // so fold it into not-hermes — the gateway test shows that verdict separately.
      return kind === "dashboard" ? "not-hermes" : kind;
    },
  });
  return NextResponse.json({ available, optedIn: true, candidates });
}

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
  // Spec §4 step 1 + the instance-level switch (final review C1). The opt-in record itself is also blocked
  // here — if consent remained on a non-loopback gateway, it would come back to life
  // when the switch is later turned on.
  if (
    !localDiscoveryAllowed({
      env: process.env,
      baseUrl: accessible.resource.baseUrl,
    })
  ) {
    return NextResponse.json(
      {
        errorCode: "local_discovery_unavailable",
        error: "local discovery is not available on this instance",
      },
      { status: 403 },
    );
  }
  // Only the owner can consent to reading secret files.
  if (!accessible.isOwner) {
    return NextResponse.json({ errorCode: "forbidden", error: "owner only" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));

  if (body?.action === "opt-in") {
    await db
      .update(gatewayResources)
      .set({
        localDiscoveryOptedInAt: nowForDb(),
        localDiscoveryOptedInBy: userId,
      })
      .where(eq(gatewayResources.id, id));
    return NextResponse.json({ ok: true, optedIn: true });
  }

  if (!optedIn(accessible.resource)) {
    return NextResponse.json(
      { errorCode: "not_opted_in", error: "opt-in required" },
      { status: 403 },
    );
  }

  const names: string[] = Array.isArray(body?.profiles)
    ? body.profiles.filter((n: unknown) => typeof n === "string")
    : [];
  if (!names.length) {
    return NextResponse.json(
      { errorCode: "no_profiles", error: "no profiles selected" },
      { status: 400 },
    );
  }

  const root = resolveProfilesRoot(process.env, homedir());
  const fs = nodeProfileFs();
  const results: { name: string; ok: boolean; errorCode?: string }[] = [];
  for (const name of names) {
    // Task 4 review, Critical 1: the names come straight from the request body. Without filtering here,
    // a name like "../../../../srv/otherapp" rides readProfileToken's path join and reads the .env
    // of an arbitrary file on the server — the registration path already uses the same validation
    // (validateProfileRegistration), so reuse that function.
    // readProfileToken itself has one more line of defense (local-profiles.ts), but filtering here first
    // is what guarantees readFileSync is never called at all.
    if (!isValidProfileName(name)) {
      results.push({ name, ok: false, errorCode: "invalid_profile_name" });
      continue;
    }
    const token = readProfileToken(root, name, fs);
    if (!token) {
      results.push({ name, ok: false, errorCode: "no_token" });
      continue;
    }
    try {
      // The return is { profile } | { error: "forbidden" } — not an ok boolean.
      const registered = await registerHermesProfile({
        userId,
        gatewayId: id,
        profileName: name,
        token,
      });
      results.push(
        "error" in registered
          ? { name, ok: false, errorCode: registered.error }
          : { name, ok: true },
      );
    } catch (err) {
      // registerHermesProfile rethrows DB errors that are not unique violations
      // (hermes-profiles.ts). Without absorbing them here, one batch dies with 500
      // and the results of earlier profiles that already succeeded vanish from the response too. The user
      // sees "register_failed", while the cause goes to the server log the same way as the project's other
      // routes (console.error).
      console.error(`Failed to register Hermes profile "${name}":`, err);
      results.push({ name, ok: false, errorCode: "register_failed" });
    }
  }
  return NextResponse.json({ results });
}
