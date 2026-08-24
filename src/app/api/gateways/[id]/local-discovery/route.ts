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

/** 옵인 전에는 파일시스템을 건드리지 않는다. */
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

  // 스펙 §4 1단계 + 인스턴스 레벨 스위치 (최종 리뷰 C1). 둘 중 하나라도 아니면
  // 파일시스템 경로를 만들지도, 존재를 확인하지도 않는다. 기능은 에러가 아니라
  // 부재로 보인다 — 프로필 루트가 없는 컨테이너와 같은 모양이다.
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
  // 능력 검사(스펙 §4 2단계): 루트가 실제로 있는가. URL이 127.0.0.1이어도
  // 컨테이너 안이면 없다.
  const available = fs.existsSync(root);

  if (!optedIn(accessible.resource)) {
    return NextResponse.json({ available, optedIn: false, candidates: [] });
  }

  // 옵인은 소유자의 동의다 — share를 받은 사용자에게까지 그 동의 범위를 넓히지
  // 않는다. 소유자 머신의 프로필 디렉토리 이름(및 토큰 보유 여부)은 파일시스템
  // 내용의 부분 노출이라, POST가 이미 소유자 전용인 것과 대칭을 맞춘다
  // (Task 4 리뷰, Important 1).
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
      // 로컬 디스커버리가 묻는 것은 "이 프로필이 이 게이트웨이에 있는가"다.
      // 주소가 API Server 가 아니면(대시보드 등) 프로필 유무를 논할 수 없으므로
      // not-hermes 로 접는다 — 그 판정은 게이트웨이 테스트가 따로 보여준다.
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
  // 스펙 §4 1단계 + 인스턴스 레벨 스위치 (최종 리뷰 C1). 옵인 기록 자체도 여기서
  // 막는다 — 루프백이 아닌 게이트웨이에 동의가 남으면, 나중에 스위치가 켜졌을 때
  // 그 동의가 되살아난다.
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
  // 비밀 파일을 읽는 동의는 소유자만 줄 수 있다.
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
    // Task 4 리뷰, Critical 1: 이름은 요청 본문에서 온 그대로다. 여기서 거르지
    // 않으면 "../../../../srv/otherapp" 같은 이름이 readProfileToken의 경로
    // 결합을 타고 나가 서버 임의 파일의 .env를 읽는다 — 등록 경로가 이미 같은
    // 검증(validateProfileRegistration)을 쓰므로 같은 함수를 재사용한다.
    // readProfileToken 자체도 방어선을 하나 더 두지만(local-profiles.ts), 여기서
    // 먼저 걸러야 readFileSync 자체가 절대 호출되지 않는다는 것을 보장할 수 있다.
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
    } catch (err) {
      // registerHermesProfile은 unique-violation이 아닌 DB 오류를 그대로 던진다
      // (hermes-profiles.ts). 여기서 흡수하지 않으면 배치 하나가 500으로
      // 죽으면서 이미 성공한 앞선 프로필들의 결과까지 응답에서 사라진다. 사용자에게는
      // "register_failed"가 보이지만, 원인은 이 프로젝트의 다른 라우트들과 같은
      // 방식(console.error)으로 서버 로그에 남긴다.
      console.error(`Failed to register Hermes profile "${name}":`, err);
      results.push({ name, ok: false, errorCode: "register_failed" });
    }
  }
  return NextResponse.json({ results });
}
