import { NextRequest, NextResponse } from "next/server";
import { probeHermesGateway } from "@/lib/hermes/gateway-probe";

function getUserId(req: NextRequest): string | null {
  return req.headers.get("x-user-id");
}

/**
 * POST /api/channels/test-gateway — 인라인으로 입력한 게이트웨이 주소가 살아 있는지 본다.
 *
 * 예전에는 OpenClaw 의 WS 핸드셰이크(testGatewayConnection)를 걸고 그 응답으로 에이전트
 * 목록까지 받아 왔다. Hermes 는 HTTP+SSE 라 그 핸드셰이크에 403 을 돌려주고, 클라이언트는
 * 재시도하며 20초 넘게 매달린다 — 실측으로 이 경로가 "연결 테스트가 멈춘다"의 원인이었다.
 *
 * 이제 `/health` 프로브만 건다. 게이트웨이 레벨에서 확인 가능한 사실은 "이 주소에 Hermes
 * API Server 가 떠 있는가" 하나뿐이다. Hermes 의 인증은 프로필 스코프이므로 토큰이 맞는지는
 * 프로필 테스트가 따로 본다. `agents` 는 OpenClaw 개념이라 사라졌고, 응답에서도 뺀다 —
 * 빈 배열을 계속 돌려주면 호출부가 "에이전트가 0개"와 "에이전트라는 개념이 없음"을
 * 구분하지 못한다.
 */
export async function POST(req: NextRequest) {
  const userId = getUserId(req);
  if (!userId) {
    return NextResponse.json(
      { errorCode: "unauthorized", error: "unauthorized" },
      { status: 401 },
    );
  }

  let url: unknown;
  try {
    ({ url } = await req.json());
  } catch {
    return NextResponse.json(
      { ok: false, errorCode: "invalid_request_body", error: "Invalid request body" },
      { status: 400 },
    );
  }

  if (typeof url !== "string" || !url.trim()) {
    return NextResponse.json({
      ok: false,
      errorCode: "gateway_url_required",
      error: "Gateway URL is required",
    });
  }

  try {
    new URL(url);
  } catch {
    return NextResponse.json({
      ok: false,
      errorCode: "invalid_gateway_url",
      error: "Invalid gateway URL format",
    });
  }

  const probe = await probeHermesGateway(url);

  if (probe.kind === "hermes") {
    return NextResponse.json({
      ok: true,
      messageCode: "gateway_connection_succeeded",
      message: "Gateway connection succeeded.",
    });
  }

  if (probe.kind === "unreachable") {
    return NextResponse.json(
      {
        ok: false,
        errorCode: "failed_to_reach_test_endpoint",
        error: probe.error,
      },
      { status: 502 },
    );
  }

  // 주소에 무언가는 떠 있지만 Hermes API Server 가 아니다. 사용자가 고쳐야 할 것은
  // 자격증명이 아니라 주소이므로, 인증 실패와 구분해서 알린다.
  return NextResponse.json(
    {
      ok: false,
      errorCode: "not_a_hermes_gateway",
      error: `Not a Hermes API Server (HTTP ${probe.status})`,
    },
    { status: 502 },
  );
}
