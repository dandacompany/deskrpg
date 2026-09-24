import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { PluginInfo } from "./deskrpg-plugin-types";
import { parsePluginInfo } from "./plugin-capability";
import {
  applyWorkerPlugin,
  parseWorkerPluginReport,
  workerPluginWarning,
  WORKER_PLUGIN_CAPABILITY,
} from "./worker-plugin";

const gap = (profile: string, extra: Partial<Record<string, unknown>> = {}) => ({
  profile,
  link: "missing",
  enabled: false,
  disabled: false,
  ...extra,
});

function info(overrides: Partial<PluginInfo> = {}): PluginInfo {
  return {
    plugin: "deskrpg",
    version: "0.12.0",
    capabilities: ["kanban", "cron", "events", WORKER_PLUGIN_CAPABILITY],
    timezone: null,
    kanban: { dispatcher_present: true, attachments: true },
    ...overrides,
  };
}

describe("parseWorkerPluginReport", () => {
  it("keeps the list of missing profiles", () => {
    assert.deepEqual(parseWorkerPluginReport({ missing: [gap("sophie")] }), {
      missing: [{ profile: "sophie", link: "missing", enabled: false, disabled: false }],
    });
  });

  it("keeps 0.16.0's propagation and drops unknown values", () => {
    assert.deepEqual(parseWorkerPluginReport({ missing: [], propagation: "disabled" }), {
      missing: [],
      propagation: "disabled",
    });
    assert.deepEqual(parseWorkerPluginReport({ missing: [], propagation: "maybe" }), {
      missing: [],
    });
  });

  it("old plugin (no field) is undefined, detection failure (null) is null — the two are not mixed", () => {
    assert.equal(parseWorkerPluginReport(undefined), undefined);
    assert.equal(parseWorkerPluginReport(null), null);
  });

  it("drops malformed entries, and a malformed body is null", () => {
    assert.deepEqual(parseWorkerPluginReport({ missing: [gap("ok"), { profile: 3 }, "x"] }), {
      missing: [{ profile: "ok", link: "missing", enabled: false, disabled: false }],
    });
    assert.equal(parseWorkerPluginReport({ missing: "sophie" }), null);
    assert.equal(parseWorkerPluginReport("sophie"), null);
  });

  it("parsePluginInfo keeps worker_plugin, and it survives a cache round trip", () => {
    const body = { ...info(), worker_plugin: { missing: [gap("sophie")] } };
    const parsed = parsePluginInfo(body);
    assert.deepEqual(parsed?.worker_plugin, { missing: [gap("sophie")] });
    assert.deepEqual(parsePluginInfo(JSON.parse(JSON.stringify(parsed)))?.worker_plugin, {
      missing: [gap("sophie")],
    });
  });

  it("does not create a worker_plugin key from an old plugin body", () => {
    const parsed = parsePluginInfo(info());
    assert.equal(parsed && "worker_plugin" in parsed, false);
  });
});

describe("workerPluginWarning", () => {
  it("warns when there are fixable profiles", () => {
    const w = workerPluginWarning(
      info({ worker_plugin: { missing: [gap("sophie"), gap("oliver")] } }),
    );
    assert.deepEqual(w, { fixable: ["sophie", "oliver"], disabledByOperator: [] });
  });

  it("excludes operator-disabled profiles from the fix targets and reports them separately", () => {
    const w = workerPluginWarning(
      info({ worker_plugin: { missing: [gap("sophie"), gap("mia", { disabled: true })] } }),
    );
    assert.deepEqual(w, { fixable: ["sophie"], disabledByOperator: ["mia"] });
  });

  it("shows no line when there is nothing to fix — even if there are only disabled profiles", () => {
    assert.equal(workerPluginWarning(info({ worker_plugin: { missing: [] } })), null);
    assert.equal(
      workerPluginWarning(info({ worker_plugin: { missing: [gap("mia", { disabled: true })] } })),
      null,
    );
  });

  it("shows nothing when the capability is missing, the field is missing, or detection failed (null)", () => {
    assert.equal(workerPluginWarning(null), null);
    assert.equal(workerPluginWarning(info()), null);
    assert.equal(workerPluginWarning(info({ worker_plugin: null })), null);
    assert.equal(
      workerPluginWarning(
        info({ capabilities: ["kanban"], worker_plugin: { missing: [gap("sophie")] } }),
      ),
      null,
    );
  });
});

describe("applyWorkerPlugin", () => {
  it("**always** refills the cache after asking the plugin to apply", async () => {
    const calls: string[] = [];
    const out = await applyWorkerPlugin({
      ensure: async () => {
        calls.push("ensure");
        return {
          ok: true,
          data: { results: [{ profile: "sophie", link: "created", enabled: "added" }] },
        };
      },
      refreshCache: async () => {
        calls.push("refresh");
      },
    });
    // The cache can be up to 1 hour stale — without refilling, the warning remains even after applying.
    assert.deepEqual(calls, ["ensure", "refresh"]);
    assert.deepEqual(out, {
      ok: true,
      results: [{ profile: "sophie", link: "created", enabled: "added" }],
    });
  });

  it("carries per-profile failures as-is", async () => {
    const out = await applyWorkerPlugin({
      ensure: async () => ({
        ok: true,
        data: { results: [{ profile: "oliver", error: "config_unreadable" }] },
      }),
      refreshCache: async () => {},
    });
    assert.deepEqual(out, {
      ok: true,
      results: [{ profile: "oliver", error: "config_unreadable" }],
    });
  });

  it("returns the code when the plugin call fails, and still refills the cache", async () => {
    // Some profiles may already have changed — the UI must not hold a stale list.
    let refreshed = false;
    const out = await applyWorkerPlugin({
      ensure: async () => ({
        ok: false,
        status: 502,
        failure: { code: "plugin_unreachable", message: "x" },
      }),
      refreshCache: async () => {
        refreshed = true;
      },
    });
    assert.equal(refreshed, true);
    assert.deepEqual(out, { ok: false, errorCode: "plugin_unreachable" });
  });

  it("does not lose the apply result even if the cache refresh fails", async () => {
    const out = await applyWorkerPlugin({
      ensure: async () => ({ ok: true, data: { results: [] } }),
      refreshCache: async () => {
        throw new Error("probe down");
      },
    });
    assert.deepEqual(out, { ok: true, results: [] });
  });
});
