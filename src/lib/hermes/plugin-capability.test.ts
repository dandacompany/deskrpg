import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  classifyPluginProbe,
  classifyPluginProbeWithInfo,
  compareSemver,
  isMissingPluginRoute,
  meetsAutomationContract,
  parsePluginInfo,
  probeDeskrpgPlugin,
  probeDeskrpgPluginWithInfo,
  resolvePluginStatusFromCache,
  shouldReprobePlugin,
  supportsProfileClone,
  supportsProfileOauth,
  supportsProfilePicker,
  supportsProviderKeys,
} from "./plugin-capability";
import type { PluginInfo } from "./deskrpg-plugin-types";

describe("classifyPluginProbe", () => {
  // Lumping 401 and 404 together leaves the user nothing to do — the former means replacing the key,
  // the latter means installing the plugin on the gateway machine.
  const cases: Array<[string, { status: number; body: unknown }, string, string | null]> = [
    [
      "200 이면 준비됨",
      { status: 200, body: { plugin: "deskrpg", version: "0.3.0" } },
      "plugin_ready",
      "0.3.0",
    ],
    [
      "200 인데 version 이 없으면 준비됐지만 버전은 모른다",
      { status: 200, body: { plugin: "deskrpg" } },
      "plugin_ready",
      null,
    ],
    ["401 은 키 문제", { status: 401, body: {} }, "plugin_unauthorized", null],
    ["403 도 키 문제로 본다", { status: 403, body: {} }, "plugin_unauthorized", null],
    ["404 는 플러그인 부재", { status: 404, body: {} }, "plugin_absent", null],
    ["500 은 모른다 — 기능을 켜지 않는다", { status: 500, body: {} }, "unknown", null],
    [
      "200 인데 본문이 우리 플러그인이 아니면 모른다",
      { status: 200, body: { hello: "world" } },
      "unknown",
      null,
    ],
    ["200 인데 본문이 객체가 아니면 모른다", { status: 200, body: "ok" }, "unknown", null],
  ];

  for (const [name, input, status, version] of cases) {
    it(name, () => {
      const got = classifyPluginProbe(input);
      assert.equal(got.status, status);
      assert.equal(got.version, version);
    });
  }
});

describe("probeDeskrpgPlugin", () => {
  it("calls the gateway-scoped path with a Bearer token", async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen.push({
        url: String(url),
        auth: new Headers(init?.headers).get("authorization"),
      });
      return new Response(JSON.stringify({ plugin: "deskrpg", version: "0.3.0" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const got = await probeDeskrpgPlugin({
      baseUrl: "http://gw.example:8642/",
      token: "default-key-1234567890",
      fetchImpl,
    });

    assert.equal(got.status, "plugin_ready");
    assert.equal(got.version, "0.3.0");
    // With a prefix it becomes profile-scoped, and the default key gets a 401.
    assert.equal(seen[0].url, "http://gw.example:8642/deskrpg/info");
    assert.equal(seen[0].auth, "Bearer default-key-1234567890");
  });

  it("returns unknown without throwing even when the response is not JSON", async () => {
    const fetchImpl = (async () =>
      new Response("<html>dashboard</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })) as unknown as typeof fetch;

    const got = await probeDeskrpgPlugin({ baseUrl: "http://x", token: "t", fetchImpl });
    assert.equal(got.status, "unknown");
  });

  it("an unreachable gateway is unknown — no exception is thrown out", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const got = await probeDeskrpgPlugin({ baseUrl: "http://x", token: "t", fetchImpl });
    assert.equal(got.status, "unknown");
  });

  // M-1: existing tests passed even with all of this signal/timer wiring removed (measured on an isolated copy).
  // Make fetchImpl actually wait for the signal's abort so the test checks the signal is really passed through.
  it("aborts the signal and returns unknown when there is no response within timeoutMs", async () => {
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      })) as unknown as typeof fetch;

    const got = await probeDeskrpgPlugin({
      baseUrl: "http://x",
      token: "t",
      fetchImpl,
      timeoutMs: 5,
    });
    assert.equal(got.status, "unknown");
  });
});

describe("shouldReprobePlugin", () => {
  const now = new Date("2026-09-01T00:00:00Z");

  it("probes if never probed before", () => {
    assert.equal(shouldReprobePlugin({ checkedAt: null, now }), true);
  });

  it("does not probe again if probed recently", () => {
    assert.equal(shouldReprobePlugin({ checkedAt: "2026-08-31T23:50:00Z", now }), false);
  });

  it("probes again if stale — the plugin may be installed later", () => {
    assert.equal(shouldReprobePlugin({ checkedAt: "2026-08-30T00:00:00Z", now }), true);
  });

  it("probes on a broken timestamp — when unsure, checking is safer", () => {
    assert.equal(shouldReprobePlugin({ checkedAt: "not-a-date", now }), true);
  });

  // PG verdict E: PostgreSQL returns pluginCheckedAt as a Date object — accepting only strings makes
  // this branch always leak into "probe again" on staging, defeating the cache.
  it("does not probe again if recent even when given a Date object (PG dialect)", () => {
    assert.equal(shouldReprobePlugin({ checkedAt: new Date("2026-08-31T23:50:00Z"), now }), false);
  });

  it("probes again if stale even when given a Date object (PG dialect)", () => {
    assert.equal(shouldReprobePlugin({ checkedAt: new Date("2026-08-30T00:00:00Z"), now }), true);
  });
});

// Final review I-1: shouldReprobePlugin was defined but had no consumer, so all Task 4·9 output
// was dead. The logic by which HermesProfileList decides "use the cache or probe again" is extracted
// into a pure function and pinned here — this test guards that decision.
describe("resolvePluginStatusFromCache", () => {
  const now = new Date("2026-09-01T00:00:00Z");

  it("uses the cached value and says no reprobe is needed when the cache is fresh and has a value", () => {
    const result = resolvePluginStatusFromCache({
      pluginStatus: "plugin_ready",
      pluginCheckedAt: "2026-08-31T23:50:00Z",
      now,
    });
    assert.deepEqual(result, { status: "plugin_ready", needsReprobe: false });
  });

  it("says a reprobe is needed when the cache is stale", () => {
    const result = resolvePluginStatusFromCache({
      pluginStatus: "plugin_ready",
      pluginCheckedAt: "2026-08-30T00:00:00Z",
      now,
    });
    assert.deepEqual(result, { status: "unknown", needsReprobe: true });
  });

  it("needs a reprobe when there is no cache at all (checkedAt null)", () => {
    const result = resolvePluginStatusFromCache({
      pluginStatus: null,
      pluginCheckedAt: null,
      now,
    });
    assert.deepEqual(result, { status: "unknown", needsReprobe: true });
  });

  it("needs a reprobe when checkedAt is fresh but pluginStatus is not a known value", () => {
    // The DB column is nullable, so in theory pluginStatus can be null while only checkedAt
    // is set — we cannot insist it is "fresh" without a value.
    const result = resolvePluginStatusFromCache({
      pluginStatus: null,
      pluginCheckedAt: "2026-08-31T23:50:00Z",
      now,
    });
    assert.deepEqual(result, { status: "unknown", needsReprobe: true });
  });

  it("accepts the PG dialect (Date object) as-is", () => {
    const result = resolvePluginStatusFromCache({
      pluginStatus: "plugin_absent",
      pluginCheckedAt: new Date("2026-08-31T23:50:00Z"),
      now,
    });
    assert.deepEqual(result, { status: "plugin_absent", needsReprobe: false });
  });
});

// The per-dialect tests for `buildPluginCacheUpdate` moved to plugin-cache-update.test.ts —
// because the function itself moved to plugin-cache-update.ts (server-only). See this file's
// header comment (HermesProfileList.tsx imports this file directly, so it can no longer
// contain `@/db`).

// ---------------------------------------------------------------------------
// Automation contract (v0.6.0+) — info parsing and the contract gate
// ---------------------------------------------------------------------------

describe("parsePluginInfo", () => {
  it("extracts the contract block (capabilities·timezone·kanban) as-is", () => {
    const got = parsePluginInfo({
      plugin: "deskrpg",
      version: "0.6.0",
      capabilities: ["kanban", "cron", "events"],
      timezone: "Asia/Seoul",
      kanban: { dispatcher_present: true, attachments: false },
    });
    assert.deepEqual(got, {
      plugin: "deskrpg",
      version: "0.6.0",
      capabilities: ["kanban", "cron", "events"],
      timezone: "Asia/Seoul",
      kanban: { dispatcher_present: true, attachments: false },
      dashboard_url: null,
    });
  });

  it("folds an old info (no capabilities) into an empty array and defaults without losing it", () => {
    const got = parsePluginInfo({ plugin: "deskrpg", version: "0.3.0" });
    assert.ok(got);
    assert.deepEqual(got.capabilities, []);
    assert.equal(got.timezone, null);
    assert.deepEqual(got.kanban, { dispatcher_present: false, attachments: false });
  });

  it("0.7.1 dashboard_url accepts only http(s) addresses — it is used as a link in the UI, so values like javascript: are dropped", () => {
    const base = { plugin: "deskrpg", version: "0.7.1" };
    assert.equal(
      parsePluginInfo({ ...base, dashboard_url: "https://deskrpg-hermes.srv1.hstgr.cloud" })
        ?.dashboard_url,
      "https://deskrpg-hermes.srv1.hstgr.cloud",
    );
    assert.equal(
      parsePluginInfo({ ...base, dashboard_url: "http://10.0.0.5:9119" })?.dashboard_url,
      "http://10.0.0.5:9119",
    );
    assert.equal(
      parsePluginInfo({ ...base, dashboard_url: "javascript:alert(1)" })?.dashboard_url,
      null,
    );
    assert.equal(parsePluginInfo({ ...base, dashboard_url: "not a url" })?.dashboard_url, null);
    assert.equal(parsePluginInfo({ ...base, dashboard_url: null })?.dashboard_url, null);
    assert.equal(parsePluginInfo(base)?.dashboard_url, null);
  });

  it("null if it is not our plugin or has no version", () => {
    assert.equal(parsePluginInfo({ hello: "world" }), null);
    assert.equal(parsePluginInfo({ plugin: "deskrpg" }), null);
    assert.equal(parsePluginInfo("ok"), null);
    assert.equal(parsePluginInfo(null), null);
  });

  it("classifyPluginProbeWithInfo attaches info on 200, null otherwise", () => {
    const got = classifyPluginProbeWithInfo({
      status: 200,
      body: { plugin: "deskrpg", version: "0.6.1", capabilities: ["kanban"] },
    });
    assert.deepEqual(got.capability, { status: "plugin_ready", version: "0.6.1" });
    assert.deepEqual(got.info?.capabilities, ["kanban"]);
    assert.equal(classifyPluginProbeWithInfo({ status: 404, body: {} }).info, null);
  });

  it("probeDeskrpgPluginWithInfo probes the same path and also returns the contract block", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          plugin: "deskrpg",
          version: "0.6.0",
          capabilities: ["kanban", "cron", "events"],
          timezone: "Asia/Seoul",
          kanban: { dispatcher_present: true, attachments: true },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    const got = await probeDeskrpgPluginWithInfo({ baseUrl: "http://gw", token: "t", fetchImpl });
    assert.equal(got.capability.status, "plugin_ready");
    assert.equal(got.info?.timezone, "Asia/Seoul");

    const dead = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const unreachable = await probeDeskrpgPluginWithInfo({
      baseUrl: "http://gw",
      token: "t",
      fetchImpl: dead,
    });
    assert.deepEqual(unreachable, {
      capability: { status: "unknown", version: null },
      info: null,
      failure: "unreachable",
    });
  });
});

describe("meetsAutomationContract", () => {
  const full = {
    plugin: "deskrpg" as const,
    version: "0.6.0",
    capabilities: ["kanban", "cron", "events"],
    timezone: "Asia/Seoul",
    kanban: { dispatcher_present: true, attachments: true },
  };

  it("0.6.0 + three capabilities passes", () => {
    assert.deepEqual(meetsAutomationContract(full), { ok: true, minVersion: "0.6.0" });
  });

  it("higher versions (0.10.0, 1.0.0) also pass — semver comparison, not string comparison", () => {
    assert.equal(meetsAutomationContract({ ...full, version: "0.10.0" }).ok, true);
    assert.equal(meetsAutomationContract({ ...full, version: "1.0.0" }).ok, true);
    assert.equal(meetsAutomationContract({ ...full, version: "0.6.0-rc.1" }).ok, true);
  });

  it("0.5.9 is version_below_minimum", () => {
    const got = meetsAutomationContract({ ...full, version: "0.5.9" });
    assert.equal(got.ok, false);
    assert.equal(got.reason, "version_below_minimum");
    assert.equal(got.minVersion, "0.6.0");
  });

  it("if any capability is missing, missing_capability with the missing names", () => {
    const got = meetsAutomationContract({ ...full, capabilities: ["kanban", "cron"] });
    assert.equal(got.ok, false);
    assert.equal(got.reason, "missing_capability");
    assert.deepEqual(got.missing, ["events"]);
  });

  it("an unparsable version is invalid_version", () => {
    const got = meetsAutomationContract({ ...full, version: "dev" });
    assert.equal(got.ok, false);
    assert.equal(got.reason, "invalid_version");
  });

  it("no_info when info is null (plugin absent or old version)", () => {
    const got = meetsAutomationContract(null);
    assert.equal(got.ok, false);
    assert.equal(got.reason, "no_info");
  });
});

describe("compareSemver", () => {
  it("compares numerically and ignores a prerelease suffix", () => {
    assert.equal(compareSemver("0.6.0", "0.6.0"), 0);
    assert.equal(compareSemver("0.10.0", "0.9.9"), 1);
    assert.equal(compareSemver("0.6", "0.6.0"), 0);
    assert.equal(compareSemver("v1.2.3", "1.2.3"), 0);
    assert.equal(compareSemver("0.6.0-rc.1", "0.6.0"), 0);
    assert.equal(compareSemver("abc", "1.0.0"), null);
  });
});

describe("employee settings picker gate", () => {
  const info = (capabilities: string[]) =>
    ({ version: "0.9.0", capabilities }) as unknown as PluginInfo;
  it("the picker requires both capabilities", () => {
    assert.equal(supportsProfilePicker(info(["profile_toolsets", "profile_skills"])), true);
    assert.equal(supportsProfilePicker(info(["profile_toolsets"])), false);
    assert.equal(supportsProfilePicker(null), false);
  });
  it("cloning is judged by profile_clone alone", () => {
    assert.equal(supportsProfileClone(info(["profile_clone"])), true);
    assert.equal(supportsProfileClone(info([])), false);
  });
  it("a 404 that is not a known plugin code means the route is missing", () => {
    assert.equal(isMissingPluginRoute({ status: 404, failure: { code: "upstream_error" } }), true);
    assert.equal(isMissingPluginRoute({ status: 404, failure: { code: "plugin_error" } }), true);
    assert.equal(
      isMissingPluginRoute({ status: 404, failure: { code: "profile_not_found" } }),
      false,
    );
    assert.equal(
      isMissingPluginRoute({ status: 404, failure: { code: "oauth_session_not_found" } }),
      false,
    );
    assert.equal(isMissingPluginRoute({ status: 500, failure: { code: "internal_error" } }), false);
  });
});

describe("provider auth gate", () => {
  const info = (capabilities: string[]) =>
    ({ version: "0.9.0", capabilities }) as unknown as PluginInfo;

  it("supportsProfileOauth is judged by profile_oauth alone", () => {
    assert.equal(supportsProfileOauth(info(["profile_oauth"])), true);
    assert.equal(supportsProfileOauth(info([])), false);
    assert.equal(supportsProfileOauth(null), false);
  });

  it("supportsProviderKeys is judged by profile_provider_keys alone", () => {
    assert.equal(supportsProviderKeys(info(["profile_provider_keys"])), true);
    assert.equal(supportsProviderKeys(info([])), false);
    assert.equal(supportsProviderKeys(null), false);
  });

  it("provider_not_found is also a 404 the plugin issued with its own code — not a missing route", () => {
    assert.equal(
      isMissingPluginRoute({ status: 404, failure: { code: "provider_not_found" } }),
      false,
    );
  });
});
