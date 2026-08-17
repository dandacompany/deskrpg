import { NextRequest, NextResponse } from "next/server";

import {
  decryptGatewayToken,
  getAccessibleGatewayResource,
} from "@/lib/gateway-resources";
import { probeHermesGateway } from "@/lib/hermes/gateway-probe";
import { getUserId } from "@/lib/internal-rpc";
import {
  buildGatewayErrorPayload,
  getGatewayErrorStatus,
  testGatewayConnection,
} from "@/lib/openclaw-gateway.js";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = getUserId(req);
  if (!userId) {
    return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  const accessible = await getAccessibleGatewayResource(userId, id);
  if (!accessible) {
    return NextResponse.json({ errorCode: "gateway_not_found", error: "Gateway not found" }, { status: 404 });
  }

  // Hermes 게이트웨이는 HTTP+SSE라 OpenClaw의 WS 핸드셰이크에 403을 돌려주고,
  // 그 클라이언트는 재시도하며 20초 넘게 매달린다. 먼저 /health를 찔러 보고,
  // Hermes로 확인되면 거기서 끝낸다. 게이트웨이 레벨에서 확인할 수 있는 것은
  // 도달성뿐이다 — 토큰 검증은 프로필 스코프라 프로필 테스트가 담당한다.
  const probe = await probeHermesGateway(accessible.resource.baseUrl);
  if (probe.kind === "hermes") {
    return NextResponse.json({
      ok: true,
      agents: [],
      messageCode: "gateway_connection_succeeded",
      message: "Gateway connection succeeded.",
    });
  }
  if (probe.kind === "unreachable") {
    // 아무것도 응답하지 않는 주소다. OpenClaw로 폴백해봐야 같은 곳에 WS 핸드셰이크를
    // 재시도하며 20~40초를 더 매달릴 뿐이라(실측), 여기서 끊는다.
    // 응답은 왔는데 Hermes가 아닌 경우(not-hermes)만 OpenClaw일 수 있다.
    return NextResponse.json(
      { ok: false, agents: [], errorCode: "failed_to_reach_test_endpoint", error: probe.error },
      { status: 502 },
    );
  }

  try {
    const result = await testGatewayConnection(
      accessible.resource.baseUrl,
      decryptGatewayToken(accessible.resource.tokenEncrypted),
    );

    return NextResponse.json({
      ok: true,
      agents: Array.isArray(result.agents) ? result.agents : [],
      messageCode: "gateway_connection_succeeded",
      message: "Gateway connection succeeded.",
    });
  } catch (err) {
    const status = getGatewayErrorStatus(err, 502);
    const payload = buildGatewayErrorPayload(err, {
      ok: false,
      fallbackErrorCode: "failed_to_reach_test_endpoint",
      fallbackError: "Unknown error",
    });

    const isPairingError = status === 409
      || (err && typeof err === "object" && "pairingRequired" in err && (err as { pairingRequired: boolean }).pairingRequired);

    if (isPairingError) {
      console.info("[gateway] Pairing required for gateway:", id);
      console.info("[gateway]   errorCode:", (payload as { errorCode?: string }).errorCode);
      console.info("[gateway]   details:", JSON.stringify((payload as { details?: unknown }).details ?? null));
    } else {
      console.error("Gateway test failed:", err);
    }

    return NextResponse.json(
      { agents: [], ...payload },
      { status },
    );
  }
}
