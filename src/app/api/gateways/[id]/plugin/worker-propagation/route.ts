import { NextResponse, type NextRequest } from "next/server";

import { safeSetupError, sameOriginMutation } from "@/lib/hermes/setup/policy";
import { setGatewayWorkerPropagation } from "@/lib/hermes/setup/service";
import { ERROR_CODE_HEADER } from "@/lib/i18n/error-codes";
import { getUserId } from "@/lib/internal-rpc";

export const runtime = "nodejs";

/**
 * Turn worker propagation (plugin 0.16.0) on or off — the gateway screen's "설정에서 켜기" and the [끄기] of the update inheritance notice.
 *
 * Writes `plugins.entries.deskrpg.worker_propagation` in the host root config through the host helper (verified by reading back),
 * and when turning on, then calls the existing apply (`POST /deskrpg/worker-plugin`) and refills the plugin info cache.
 * It is a short operation, so it responds immediately rather than as a job. It does not restart the gateway.
 *
 * It runs commands on the host, so it passes the same doors as the plugin update route: owner only, same-origin changes only,
 * host setup policy. Hosts where commands cannot run get 400 `plugin_update_unsupported_host` — the screen falls back to copying the command.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = getUserId(req);
  if (!userId) {
    return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });
  }
  if (
    !sameOriginMutation(
      req.headers.get("origin"),
      req.headers.get("host"),
      req.headers.get("sec-fetch-site"),
    )
  ) {
    return NextResponse.json(
      { errorCode: "setup_bad_origin", error: "setup_bad_origin" },
      { status: 403 },
    );
  }

  let enabled: unknown;
  try {
    enabled = ((await req.json()) as { enabled?: unknown } | null)?.enabled;
  } catch {
    enabled = undefined;
  }
  if (typeof enabled !== "boolean") {
    return NextResponse.json(
      { errorCode: "setup_invalid_request", error: "setup_invalid_request" },
      { status: 400 },
    );
  }

  const { id } = await params;
  try {
    const result = await setGatewayWorkerPropagation(userId, id, enabled);
    // Plugin failures in the apply step are 200 + errorCode like the worker-plugin route — Cloudflare replaces 5xx bodies.
    const headers: Record<string, string> = { "Cache-Control": "no-store" };
    if ("errorCode" in result) headers[ERROR_CODE_HEADER] = result.errorCode;
    return NextResponse.json(result, { headers });
  } catch (error) {
    const code = safeSetupError(error);
    const status =
      code === "setup_forbidden" || code === "setup_bad_origin"
        ? 403
        : code === "setup_not_found"
          ? 404
          : code === "setup_busy"
            ? 409
            : 400;
    return NextResponse.json({ errorCode: code, error: code }, { status });
  }
}
