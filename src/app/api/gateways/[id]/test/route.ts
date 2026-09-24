import { transportFetch } from "@/lib/hermes/setup/transport";
import { NextRequest, NextResponse } from "next/server";
import { existsSync } from "node:fs";

import { eq } from "drizzle-orm";

import { db, gatewayResources } from "@/db";
import {
  decryptGatewayToken,
  getAccessibleGatewayResource,
  persistGatewayValidationState,
} from "@/lib/gateway-resources";
import { probeHermesGateway } from "@/lib/hermes/gateway-probe";
import {
  buildPluginCacheUpdate,
  buildPluginInfoCacheUpdate,
} from "@/lib/hermes/plugin-cache-update";
import { probeDeskrpgPluginWithInfo } from "@/lib/hermes/plugin-capability";
import { diagnoseUnreachable } from "@/lib/hermes/unreachable-hint";
import { getUserId } from "@/lib/internal-rpc";
import { ERROR_CODE_HEADER } from "@/lib/i18n/error-codes";

/**
 * Probe failures are returned **as 200**. An external address the user entered not responding is
 * not our server's failure but a normal outcome of handling the request, and answering with 5xx loses the diagnosis —
 * measured: Cloudflare replaces the origin's 5xx wholesale with its own error page.
 *
 *     inside the container  502  body={"errorCode":"probe_502_marker",...}
 *     up to Caddy           502  body as is
 *     via the internet      502  server: cloudflare · body="error code: 502"
 *
 * So the browser received only `502 {}` and the screen showed only the generic fallback. 4xx passes through, so
 * auth and permission responses are left as is. The code is also carried in a header so it survives behind other proxies.
 */
const PROBE_RESULT_INIT = (errorCode: string) => ({
  status: 200,
  headers: { [ERROR_CODE_HEADER]: errorCode },
});

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

  // All that can be checked at the gateway level is reachability — Hermes auth is profile-
  // scoped, so token validation belongs to the profile test. The probe used to fall back to OpenClaw's
  // WS handshake when it could not identify hermes, but that backend has been removed.
  const probe = await probeHermesGateway(accessible.resource.baseUrl);

  if (probe.kind === "hermes") {
    // Probe the plugin only after it is confirmed to be Hermes — no reason to send our
    // paths to something that is not an API Server.
    // The response shape (`plugin: {status, version}`) stays as is, and only the automation contract block (info)
    // is also kept in the `plugin_info_json` cache — board securing (kanban-boards.ts) decides with it.
    const probed = await probeDeskrpgPluginWithInfo({
      fetchImpl: transportFetch,
      baseUrl: accessible.resource.baseUrl,
      // deskrpg-allow-token-arg: an argument the server uses to call Hermes, not a response.
      token: decryptGatewayToken(accessible.resource.tokenEncrypted),
    });
    const plugin = probed.capability;
    await db
      .update(gatewayResources)
      .set({ ...buildPluginCacheUpdate(plugin), ...buildPluginInfoCacheUpdate(probed.info) })
      .where(eq(gatewayResources.id, id));

    // Also record the probe result **as the validation state**. It used to write only plugin_* and
    // leave last_validation_status empty, so no matter how often the connection test was pressed the list
    // stayed at "아직 테스트하지 않음" (staging measurement 2026-09-07).
    // persistGatewayValidationState existed before this branch but was **dead code nobody
    // called**.
    await persistGatewayValidationState(id, { status: "valid", error: null });

    return NextResponse.json({
      ok: true,
      messageCode: "gateway_connection_succeeded",
      message: "Gateway connection succeeded.",
      plugin,
    });
  }

  if (probe.kind === "dashboard") {
    // The address is Hermes but not the API Server. Most often it is attached to the dashboard (default 9119),
    // so what needs fixing is the port, not the token.
    await persistGatewayValidationState(id, {
      status: "error",
      error: `gateway_is_not_api_server (HTTP ${probe.status})`,
    });
    return NextResponse.json(
      {
        ok: false,
        errorCode: "gateway_is_not_api_server",
        error: `Reached a Hermes web UI, not the API Server (HTTP ${probe.status})`,
      },
      PROBE_RESULT_INIT("gateway_is_not_api_server"),
    );
  }

  if (probe.kind === "unreachable") {
    // Narrow down why it could not be reached. The most common cause is not the address but **from where the address is seen**
    // — inside a container 127.0.0.1 is the container itself, not Hermes.
    const errorCode = diagnoseUnreachable({
      baseUrl: accessible.resource.baseUrl,
      inContainer: existsSync("/.dockerenv"),
    });
    await persistGatewayValidationState(id, {
      status: "unreachable",
      error: probe.error,
    });
    return NextResponse.json(
      { ok: false, errorCode, error: probe.error },
      PROBE_RESULT_INIT(errorCode),
    );
  }

  // A response came, but it is not a Hermes API Server. What needs fixing is the address, not credentials.
  await persistGatewayValidationState(id, {
    status: "error",
    error: `not_a_hermes_gateway (HTTP ${probe.status})`,
  });
  return NextResponse.json(
    {
      ok: false,
      errorCode: "not_a_hermes_gateway",
      error: `Not a Hermes API Server (HTTP ${probe.status})`,
    },
    PROBE_RESULT_INIT("not_a_hermes_gateway"),
  );
}
