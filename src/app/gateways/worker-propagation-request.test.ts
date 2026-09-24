import assert from "node:assert/strict";
import test from "node:test";

import { enableWorkerPropagationRequest } from "./worker-propagation-request";

function fakeFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status, headers });
  }) as typeof fetch;
  return { calls, impl };
}

test("POSTs {enabled:true}, and includes the results when it turned on and applied", async () => {
  const results = [{ profile: "sophie", link: "created", enabled: "added" }];
  const { calls, impl } = fakeFetch(200, { propagation: "enabled", results });
  assert.deepEqual(await enableWorkerPropagationRequest("gw 1", impl), { ok: true, results });
  assert.equal(calls[0].url, "/api/gateways/gw%201/plugin/worker-propagation");
  assert.equal(calls[0].init?.method, "POST");
  assert.equal(calls[0].init?.body, JSON.stringify({ enabled: true }));
});

test("turned on but apply failed (200 + header code) gives applyErrorCode", async () => {
  const { impl } = fakeFetch(
    200,
    { propagation: "enabled" },
    { "X-DeskRPG-Error-Code": "plugin_unreachable" },
  );
  assert.deepEqual(await enableWorkerPropagationRequest("gw", impl), {
    ok: true,
    applyErrorCode: "plugin_unreachable",
  });
});

test("host-step failures (4xx) keep their code, and without a body it is http_<status>", async () => {
  const unsupported = fakeFetch(400, { errorCode: "plugin_update_unsupported_host" });
  assert.deepEqual(await enableWorkerPropagationRequest("gw", unsupported.impl), {
    ok: false,
    errorCode: "plugin_update_unsupported_host",
  });
  const bare = fakeFetch(409, {});
  assert.deepEqual(await enableWorkerPropagationRequest("gw", bare.impl), {
    ok: false,
    errorCode: "http_409",
  });
});

test("a 200 that does not say it turned on is not treated as on", async () => {
  const { impl } = fakeFetch(200, { propagation: "disabled" });
  assert.deepEqual(await enableWorkerPropagationRequest("gw", impl), {
    ok: false,
    errorCode: "propagation_not_enabled",
  });
});
