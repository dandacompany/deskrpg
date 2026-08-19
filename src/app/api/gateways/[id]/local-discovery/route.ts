import { NextRequest, NextResponse } from "next/server";
import { homedir } from "node:os";

import { eq } from "drizzle-orm";

import { db, gatewayResources, isPostgres } from "@/db";
import { getAccessibleGatewayResource } from "@/lib/gateway-resources";
import { probeHermesGateway } from "@/lib/hermes/gateway-probe";
import { discoverLocalProfiles } from "@/lib/hermes/local-discovery";
import {
  listLocalProfiles,
  nodeProfileFs,
  readProfileToken,
  resolveProfilesRoot,
} from "@/lib/hermes/local-profiles";
import {
  listHermesProfiles,
  registerHermesProfile,
} from "@/lib/hermes-profiles";
import { getUserId } from "@/lib/internal-rpc";

function nowForDb() {
  return (isPostgres
    ? new Date()
    : new Date().toISOString()) as unknown as Date;
}

/** 옵인 전에는 파일시스템을 건드리지 않는다. */
function optedIn(resource: { localDiscoveryOptedInAt?: string | Date | null }) {
  return !!resource.localDiscoveryOptedInAt;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = getUserId(req);
  if (!userId) {
    return NextResponse.json(
      { errorCode: "unauthorized", error: "unauthorized" },
      { status: 401 },
    );
  }
  const { id } = await params;
  const accessible = await getAccessibleGatewayResource(userId, id);
  if (!accessible) {
    return NextResponse.json(
      { errorCode: "gateway_not_found", error: "Gateway not found" },
      { status: 404 },
    );
  }

  const root = resolveProfilesRoot(process.env, homedir());
  const fs = nodeProfileFs();
  // 능력 검사: 루트가 실제로 있는가. URL이 127.0.0.1이어도 컨테이너 안이면 없다.
  const available = fs.existsSync(root);

  if (!optedIn(accessible.resource)) {
    return NextResponse.json({ available, optedIn: false, candidates: [] });
  }

  const registered = await listHermesProfiles(userId, id);
  const candidates = await discoverLocalProfiles({
    baseUrl: accessible.resource.baseUrl,
    localProfiles: listLocalProfiles(root, fs),
    registeredNames: registered.map((r) => r.profileName),
    probe: async (baseUrl, profile) =>
      (await probeHermesGateway(baseUrl, { profile })).kind,
  });
  return NextResponse.json({ available, optedIn: true, candidates });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = getUserId(req);
  if (!userId) {
    return NextResponse.json(
      { errorCode: "unauthorized", error: "unauthorized" },
      { status: 401 },
    );
  }
  const { id } = await params;
  const accessible = await getAccessibleGatewayResource(userId, id);
  if (!accessible) {
    return NextResponse.json(
      { errorCode: "gateway_not_found", error: "Gateway not found" },
      { status: 404 },
    );
  }
  // 비밀 파일을 읽는 동의는 소유자만 줄 수 있다.
  if (!accessible.isOwner) {
    return NextResponse.json(
      { errorCode: "forbidden", error: "owner only" },
      { status: 403 },
    );
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
    const token = readProfileToken(root, name, fs);
    if (!token) {
      results.push({ name, ok: false, errorCode: "no_token" });
      continue;
    }
    // 반환은 { profile } | { error: "forbidden" } 이다 — ok 불리언이 아니다.
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
  }
  return NextResponse.json({ results });
}
