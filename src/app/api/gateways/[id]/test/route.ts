import { NextRequest, NextResponse } from "next/server";

import { getAccessibleGatewayResource } from "@/lib/gateway-resources";
import { probeHermesGateway } from "@/lib/hermes/gateway-probe";
import { getUserId } from "@/lib/internal-rpc";

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

  // 게이트웨이 레벨에서 확인할 수 있는 것은 도달성뿐이다 — Hermes 의 인증은 프로필
  // 스코프라 토큰 검증은 프로필 테스트가 담당한다. 예전에는 프로브가 hermes 로 판정하지
  // 못하면 OpenClaw 의 WS 핸드셰이크로 폴백했지만, 그 백엔드는 제거됐다.
  const probe = await probeHermesGateway(accessible.resource.baseUrl);

  if (probe.kind === "hermes") {
    return NextResponse.json({
      ok: true,
      messageCode: "gateway_connection_succeeded",
      message: "Gateway connection succeeded.",
    });
  }

  if (probe.kind === "unreachable") {
    return NextResponse.json(
      { ok: false, errorCode: "failed_to_reach_test_endpoint", error: probe.error },
      { status: 502 },
    );
  }

  // 응답은 왔지만 Hermes API Server 가 아니다. 고쳐야 할 것은 자격증명이 아니라 주소다.
  return NextResponse.json(
    {
      ok: false,
      errorCode: "not_a_hermes_gateway",
      error: `Not a Hermes API Server (HTTP ${probe.status})`,
    },
    { status: 502 },
  );
}
