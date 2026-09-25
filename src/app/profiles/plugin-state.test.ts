import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { PLUGIN_VERSION } from "@/lib/hermes/setup/pin";

import { loadGatewayPluginState } from "./plugin-state";

type Row = {
  id: string;
  isOwner?: boolean;
  pluginStatus: string | null;
  pluginVersion?: string | null;
  pluginCheckedAt: string | null;
  supportsProfileClone?: boolean;
};

/** A fake server: the list answers from `rows()`, the plugin test answers `testStatus` and may change the rows. */
function fakeServer(opts: { rows: () => Row[]; testStatus?: string; onTest?: () => void }) {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.startsWith("/api/gateways?") || url === "/api/gateways") {
      return new Response(JSON.stringify({ gateways: opts.rows() }));
    }
    if (url === "/api/gateways/gw-1/test") {
      opts.onTest?.();
      return new Response(JSON.stringify({ ok: true, plugin: { status: opts.testStatus } }));
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

describe("loadGatewayPluginState", () => {
  test("a fresh cache is used as-is with no plugin test", async () => {
    const server = fakeServer({
      rows: () => [
        {
          id: "gw-1",
          isOwner: true,
          pluginStatus: "plugin_ready",
          pluginVersion: PLUGIN_VERSION,
          pluginCheckedAt: minutesAgo(10),
        },
      ],
    });
    const state = await loadGatewayPluginState("gw-1", { fetchImpl: server.fetchImpl });
    assert.equal(state.pluginStatus, "plugin_ready");
    assert.equal(state.row?.isOwner, true);
    assert.deepEqual(server.calls, ["GET /api/gateways?refreshPlugin=1"]);
  });

  // The employee detail page used to take the stale cache's `unknown` as-is, locking persona and
  // model editing an hour after the last probe with no way to unlock it from that page.
  test("a cache older than the hour is re-checked, and a ready plugin unlocks", async () => {
    let checkedAt = minutesAgo(61);
    const server = fakeServer({
      rows: () => [{ id: "gw-1", pluginStatus: "plugin_ready", pluginCheckedAt: checkedAt }],
      testStatus: "plugin_ready",
      onTest: () => {
        checkedAt = minutesAgo(0);
      },
    });
    const state = await loadGatewayPluginState("gw-1", { fetchImpl: server.fetchImpl });
    assert.equal(state.pluginStatus, "plugin_ready");
    assert.deepEqual(server.calls, [
      "GET /api/gateways?refreshPlugin=1",
      "POST /api/gateways/gw-1/test",
      "GET /api/gateways",
    ]);
  });

  test("capability fields come from the row re-read after the re-check", async () => {
    let upgraded = false;
    const server = fakeServer({
      rows: () => [
        {
          id: "gw-1",
          pluginStatus: "plugin_ready",
          pluginVersion: upgraded ? PLUGIN_VERSION : "0.8.0",
          pluginCheckedAt: upgraded ? minutesAgo(0) : minutesAgo(20),
          supportsProfileClone: upgraded,
        },
      ],
      testStatus: "plugin_ready",
      onTest: () => {
        upgraded = true;
      },
    });
    const state = await loadGatewayPluginState("gw-1", { fetchImpl: server.fetchImpl });
    assert.equal(state.row?.supportsProfileClone, true);
  });

  test("force re-checks even a fresh cache (the page's re-check button)", async () => {
    const server = fakeServer({
      rows: () => [
        {
          id: "gw-1",
          pluginStatus: "unknown",
          pluginVersion: null,
          pluginCheckedAt: minutesAgo(1),
        },
      ],
      testStatus: "plugin_ready",
    });
    const state = await loadGatewayPluginState("gw-1", {
      fetchImpl: server.fetchImpl,
      force: true,
    });
    assert.equal(state.pluginStatus, "plugin_ready");
    assert.ok(server.calls.includes("POST /api/gateways/gw-1/test"));
  });

  test("a failed list read still re-checks, and a failed re-check is unknown", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (String(input) === "/api/gateways/gw-1/test") throw new Error("offline");
      throw new Error("offline");
    }) as typeof fetch;
    const state = await loadGatewayPluginState("gw-1", { fetchImpl });
    assert.equal(state.pluginStatus, "unknown");
    assert.equal(state.row, null);
  });
});
