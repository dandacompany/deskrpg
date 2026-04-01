import { NextRequest, NextResponse } from "next/server";

import {
  decryptGatewayToken,
  getAccessibleGatewayResource,
} from "@/lib/gateway-resources";
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
    return NextResponse.json(
      {
        agents: [],
        ...buildGatewayErrorPayload(err, {
          ok: false,
          fallbackErrorCode: "failed_to_reach_test_endpoint",
          fallbackError: "Unknown error",
        }),
      },
      { status: getGatewayErrorStatus(err, 502) },
    );
  }
}
