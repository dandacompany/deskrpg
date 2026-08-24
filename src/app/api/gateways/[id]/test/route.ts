import { NextRequest, NextResponse } from "next/server";

import { getAccessibleGatewayResource } from "@/lib/gateway-resources";
import { probeHermesGateway } from "@/lib/hermes/gateway-probe";
import { diagnoseUnreachable } from "@/lib/hermes/unreachable-hint";
import { existsSync } from "node:fs";
import { getUserId } from "@/lib/internal-rpc";

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

  if (probe.kind === "dashboard") {
    // 주소는 Hermes 인데 API Server 가 아니다. 대시보드(기본 9119)에 붙은 경우가
    // 대부분이라, 고쳐야 할 것은 토큰이 아니라 포트다.
    return NextResponse.json(
      {
        ok: false,
        errorCode: "gateway_is_not_api_server",
        error: `Reached a Hermes web UI, not the API Server (HTTP ${probe.status})`,
      },
      { status: 502 },
    );
  }

  if (probe.kind === "unreachable") {
    // 왜 못 닿았는지까지 좁힌다. 가장 흔한 원인은 주소가 아니라 **어디서 보는 주소인가**다
    // — 컨테이너 안에서 127.0.0.1 은 Hermes 가 아니라 컨테이너 자신이다.
    const errorCode = diagnoseUnreachable({
      baseUrl: accessible.resource.baseUrl,
      inContainer: existsSync("/.dockerenv"),
    });
    return NextResponse.json({ ok: false, errorCode, error: probe.error }, { status: 502 });
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
