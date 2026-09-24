import { NextResponse, type NextRequest } from "next/server";

import { safeSetupError, sameOriginMutation } from "@/lib/hermes/setup/policy";
import { startPluginUpdate } from "@/lib/hermes/setup/service";
import { getUserId } from "@/lib/internal-rpc";

export const runtime = "nodejs";

/**
 * Upgrade the plugin of an already registered gateway to the pinned version (owner only).
 *
 * It rides the same host pipeline as the wizard but runs only the update step, and does not touch the gateway's
 * name, address or token. It is a long operation, so a job id is returned immediately and progress is read through the
 * `/api/gateways/setup` job query — the same screen the wizard uses.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = getUserId(req);
  if (!userId) {
    return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });
  }
  // This runs commands on the host — another site must not be able to trigger it with a single link.
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

  const { id } = await params;
  try {
    const job = await startPluginUpdate(userId, id);
    return NextResponse.json({ jobId: job.id }, { headers: { "Cache-Control": "no-store" } });
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
