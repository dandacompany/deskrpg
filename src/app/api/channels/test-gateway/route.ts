import { NextRequest, NextResponse } from "next/server";
import {
  buildGatewayErrorPayload,
  getGatewayErrorStatus,
  testGatewayConnection,
} from "@/lib/openclaw-gateway.js";

function getUserId(req: NextRequest): string | null {
  return req.headers.get("x-user-id");
}

// POST /api/channels/test-gateway — validate gateway config with a real gateway round-trip
export async function POST(req: NextRequest) {
  const userId = getUserId(req);
  if (!userId) return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });

  try {
    const body = await req.json();
    const { url, token } = body;

    if (!url) {
      return NextResponse.json({
        ok: false,
        agents: [],
        errorCode: "gateway_url_required",
        error: "Gateway URL is required",
      });
    }

    // Validate URL format
    try {
      new URL(url);
    } catch {
      return NextResponse.json({
        ok: false,
        agents: [],
        errorCode: "invalid_gateway_url",
        error: "Invalid gateway URL format",
      });
    }

    const result = await testGatewayConnection(url, token);

    return NextResponse.json({
      ok: true,
      agents: Array.isArray(result.agents) ? result.agents : [],
      messageCode: "gateway_connection_succeeded",
      message: "Gateway connection succeeded.",
    });
  } catch (err) {
    console.error("Gateway validation failed:", err);
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
