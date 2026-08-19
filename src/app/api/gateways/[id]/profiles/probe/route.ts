import { NextRequest, NextResponse } from "next/server";

import { getAccessibleGatewayResource } from "@/lib/gateway-resources";
import { probeHermesGateway } from "@/lib/hermes/gateway-probe";
import { getUserId } from "@/lib/internal-rpc";

// src/app/api/gateways/[id]/profiles/validation.ts 와 같은 규칙. 등록 가능한 이름은
// 전부 통과하므로, 여기서 거른다고 정상적인 프로필 이름이 걸리지 않는다.
//
// 검증 없이 탐침에 넘기면 위험하다: encodeURIComponent는 "."을 이스케이프하지
// 않으므로 ".."이 경로 세그먼트로 살아 들어가고, URL 정규화가 `/p/../health`를
// `/health`로 접는다. 그러면 게이트웨이 루트 health가 200을 돌려주고, 존재하지
// 않는 프로필에 "확인됨"이 뜬다.
const PROFILE_NAME_RE = /^[A-Za-z0-9._-]*[A-Za-z0-9][A-Za-z0-9._-]*$/;

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
  const body = await req.json().catch(() => ({}));
  const profileName =
    typeof body?.profileName === "string" ? body.profileName.trim() : "";
  if (!profileName) {
    return NextResponse.json({ status: "unknown" });
  }
  // 게이트웨이를 찌르기 전에 이름 규칙을 적용한다 — 통과하지 못하면 아예 fetch를
  // 호출하지 않는다.
  if (!PROFILE_NAME_RE.test(profileName)) {
    return NextResponse.json({ status: "not_found" });
  }
  const probe = await probeHermesGateway(accessible.resource.baseUrl, {
    profile: profileName,
  });
  // 세 상태를 뭉개지 않는다 — "없는 프로필"과 "게이트웨이가 죽었다"는 다른 문제다.
  const status =
    probe.kind === "hermes"
      ? "ok"
      : probe.kind === "not-hermes"
        ? "not_found"
        : "unknown";
  return NextResponse.json({ status });
}
