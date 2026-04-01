import { NextRequest, NextResponse } from "next/server";

function getUserId(req: NextRequest): string | null {
  return req.headers.get("x-user-id");
}

// POST /api/channels/test-gateway — validate gateway config (actual connection test happens after channel creation)
export async function POST(req: NextRequest) {
  const userId = getUserId(req);
  if (!userId) return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });

  try {
    const body = await req.json();
    const { url } = body;

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

    // Config looks valid — actual connection test will happen after channel creation via RPC
    return NextResponse.json({
      ok: true,
      agents: [],
      messageCode: "gateway_config_validated",
      message: "Gateway config validated. Connection will be established when channel is created.",
    });
  } catch (err) {
    console.error("Gateway validation failed:", err);
    return NextResponse.json({
      ok: false,
      agents: [],
      errorCode: "failed_to_reach_test_endpoint",
      error: err instanceof Error ? err.message : "Unknown error",
    });
  }
}
