import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  CronApiError,
  PLUGIN_INSTALL_COMMAND,
  PLUGIN_MIN_VERSION,
  classifyCronError,
  cronApi,
} from "./cron-api";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("cron-api — the browser only calls /api/channels/...", () => {
  it("list/detail/history/mutation all hit the channel cron routes (no direct Hermes calls)", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (url.endsWith("/run")) return json(202, { accepted: true });
      return json(200, { jobs: [], timezone: "Asia/Seoul", runs: [], targets: [], blueprints: [] });
    }) as typeof fetch;

    await cronApi.listJobs("ch1");
    await cronApi.listJobs("ch1", "npc1");
    await cronApi.listRuns("ch1", "job1", "npc1", 5);
    await cronApi.createJob("ch1", {
      npcId: "npc1",
      name: "n",
      prompt: "p",
      schedule: "0 9 * * *",
      deliver: "local",
    });
    await cronApi.updateJob("ch1", "job1", "npc1", { prompt: "q" });
    await cronApi.pauseJob("ch1", "job1", "npc1");
    await cronApi.resumeJob("ch1", "job1", "npc1");
    await cronApi.runJob("ch1", "job1", "npc1");
    await cronApi.deleteJob("ch1", "job1", "npc1");
    await cronApi.listDeliveryTargets("ch1", "npc1");
    await cronApi.listBlueprints("ch1", "npc1");
    await cronApi.instantiateBlueprint("ch1", { npcId: "npc1", blueprint: "bp", values: {} });

    for (const call of calls) {
      assert.ok(call.url.startsWith("/api/channels/ch1/cron/"), call.url);
    }
    assert.equal(calls[0].url, "/api/channels/ch1/cron/jobs");
    assert.equal(calls[1].url, "/api/channels/ch1/cron/jobs?npcId=npc1");
    assert.equal(calls[2].url, "/api/channels/ch1/cron/jobs/job1/runs?npcId=npc1&limit=5");
    assert.equal(calls[3].method, "POST");
    assert.equal((calls[3].body as { npcId: string }).npcId, "npc1");
    assert.equal(calls[4].method, "PUT");
    assert.deepEqual(calls[4].body, { npcId: "npc1", updates: { prompt: "q" } });
    assert.equal(calls[5].url, "/api/channels/ch1/cron/jobs/job1/pause");
    assert.equal(calls[6].url, "/api/channels/ch1/cron/jobs/job1/resume");
    assert.equal(calls[7].url, "/api/channels/ch1/cron/jobs/job1/run");
    assert.equal(calls[8].method, "DELETE");
    assert.equal(calls[8].url, "/api/channels/ch1/cron/jobs/job1?npcId=npc1");
    assert.equal(calls[9].url, "/api/channels/ch1/cron/delivery-targets?npcId=npc1");
    assert.equal(calls[10].url, "/api/channels/ch1/cron/blueprints?npcId=npc1");
    assert.equal(calls[11].url, "/api/channels/ch1/cron/blueprints/instantiate");
  });

  it("a failure response throws a CronApiError carrying the server's {code,message}", async () => {
    globalThis.fetch = (async () =>
      json(403, { code: "cron_read_only", message: "nope" })) as typeof fetch;
    await assert.rejects(cronApi.pauseJob("ch1", "j", "n"), (err: unknown) => {
      assert.ok(err instanceof CronApiError);
      assert.equal(err.status, 403);
      assert.equal(err.code, "cron_read_only");
      assert.equal(err.message, "nope");
      return true;
    });
  });

  it("builds a code from status even when the body isn't JSON", async () => {
    globalThis.fetch = (async () =>
      new Response("<html>", { status: 502, statusText: "Bad Gateway" })) as typeof fetch;
    await assert.rejects(cronApi.listJobs("ch1"), (err: unknown) => {
      assert.ok(err instanceof CronApiError);
      assert.equal(err.code, "http_502");
      return true;
    });
  });
});

describe("classifyCronError (R31/R32)", () => {
  it("428 plugin_upgrade_required -> upgrade notice + install command, response minVersion wins", () => {
    const notice = classifyCronError(
      new CronApiError(428, "plugin_upgrade_required", "old", { minVersion: "0.7.0" }),
    );
    assert.deepEqual(notice, {
      kind: "upgrade",
      minVersion: "0.7.0",
      command: PLUGIN_INSTALL_COMMAND,
    });
    const fallback = classifyCronError(new CronApiError(428, "plugin_upgrade_required", "old", {}));
    assert.equal(fallback.kind === "upgrade" && fallback.minVersion, PLUGIN_MIN_VERSION);
    assert.match(PLUGIN_INSTALL_COMMAND, /hermes plugins install .*deskrpg-hermes-plugin/);
    assert.match(PLUGIN_INSTALL_COMMAND, /hermes plugins enable deskrpg/);
  });

  it("409 gateway_not_bound -> gateway connection notice", () => {
    assert.deepEqual(classifyCronError(new CronApiError(409, "gateway_not_bound", "x", {})), {
      kind: "gateway",
    });
  });

  it("everything else passes the code/message through as-is", () => {
    assert.deepEqual(classifyCronError(new CronApiError(403, "cron_read_only", "nope", {})), {
      kind: "other",
      code: "cron_read_only",
      message: "nope",
      status: 403,
    });
    assert.deepEqual(classifyCronError(new Error("boom")), {
      kind: "other",
      code: "unknown",
      message: "boom",
      status: 0,
    });
  });
});
