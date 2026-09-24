import { isManagedSshUrl } from "@/lib/hermes/setup/transport-id";
import { NextRequest, NextResponse } from "next/server";
import { probeHermesGateway } from "@/lib/hermes/gateway-probe";

function getUserId(req: NextRequest): string | null {
  return req.headers.get("x-user-id");
}

/**
 * POST /api/channels/test-gateway — check whether an inline-entered gateway address is alive.
 *
 * This used to perform OpenClaw's WS handshake (testGatewayConnection) and fetch the agent list
 * from its response. Hermes is HTTP+SSE, so it answers that handshake with 403, and the client
 * retries and hangs for over 20 seconds — measurement showed this path was the cause of "the connection test freezes".
 *
 * Now only a `/health` probe is made. The only fact checkable at the gateway level is "is a Hermes
 * API Server running at this address". Hermes auth is profile-scoped, so whether the token is right is
 * checked separately by the profile test. `agents` was an OpenClaw concept and is gone, and it is dropped from the response too —
 * returning an empty array would keep callers from telling "0 agents" apart from "there is no
 * such thing as agents".
 */
export async function POST(req: NextRequest) {
  const userId = getUserId(req);
  if (!userId) {
    return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });
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

  if (isManagedSshUrl(url)) {
    return NextResponse.json(
      { errorCode: "setup_invalid_request", error: "setup_invalid_request" },
      { status: 400 },
    );
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

  // Something is running at the address, but it is not a Hermes API Server. What the user must fix is
  // the address, not credentials, so report it separately from an auth failure.
  return NextResponse.json(
    {
      ok: false,
      errorCode: "not_a_hermes_gateway",
      error: `Not a Hermes API Server (HTTP ${probe.status})`,
    },
    { status: 502 },
  );
}
