import { NextResponse, type NextRequest } from "next/server";

import { getOwnedGatewayResource } from "@/lib/gateway-resources";
import { sameOriginMutation } from "@/lib/hermes/setup/policy";
import { gatewayWorkerPluginDeps } from "@/lib/hermes/setup/service";
import { applyWorkerPlugin } from "@/lib/hermes/worker-plugin";
import { ERROR_CODE_HEADER } from "@/lib/i18n/error-codes";
import { getUserId } from "@/lib/internal-rpc";

export const runtime = "nodejs";

/**
 * Also place the plugin in the employee profile homes that kanban workers and cron start from (gateway owner only).
 *
 * Calls the plugin's `POST /deskrpg/worker-plugin` with the owner key, and afterwards **rereads the plugin info
 * to refill the cache** — the cache can be up to an hour stale, so otherwise the warning stays even after applying.
 * It is a short call (two files per employee), so unlike the plugin update it does not run as a job.
 *
 * Uses the same guards as the plugin update route: owner only, same-origin changes only.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = getUserId(req);
  if (!userId) {
    return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });
  }
  // This changes employees' Hermes config files — another site must not be able to trigger it with a single link.
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
  const resource = await getOwnedGatewayResource(userId, id);
  if (!resource) {
    // Do not distinguish someone else's gateway from a nonexistent one — do not leak existence.
    return NextResponse.json({ errorCode: "not_found", error: "not found" }, { status: 404 });
  }

  const outcome = await applyWorkerPlugin(gatewayWorkerPluginDeps(resource));

  if (!outcome.ok) {
    // Like the gateway proxy routes, 200 + errorCode — Cloudflare replaces 5xx bodies.
    return NextResponse.json(
      { errorCode: outcome.errorCode, error: outcome.errorCode },
      { status: 200, headers: { [ERROR_CODE_HEADER]: outcome.errorCode } },
    );
  }
  return NextResponse.json(
    { results: outcome.results },
    { headers: { "Cache-Control": "no-store" } },
  );
}
