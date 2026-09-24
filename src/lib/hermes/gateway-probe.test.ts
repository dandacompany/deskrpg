import test from "node:test";
import assert from "node:assert/strict";

import { probeHermesGateway } from "./gateway-probe";

function fakeFetch(impl: (url: string) => Promise<Response> | Response) {
  return ((input: RequestInfo | URL) =>
    Promise.resolve(impl(String(input)))) as unknown as typeof fetch;
}

/** Measured responses from a real Hermes API Server. /health is unauthenticated 200, /v1/models is 401 JSON. */
function apiServerFetch(onCall?: (url: string) => void) {
  return fakeFetch((url) => {
    onCall?.(url);
    if (url.endsWith("/health")) return new Response("ok", { status: 200 });
    return new Response(JSON.stringify({ error: { code: "gateway_auth_failed" } }), {
      status: 401,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  });
}

/** The Hermes dashboard (SPA). Measured: returns 200 + HTML for any path. */
function dashboardFetch() {
  return fakeFetch(
    () =>
      new Response("<!doctype html><html><head>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
  );
}

test("probeHermesGateway", async (t) => {
  await t.test("classifies /health 200 as hermes", async () => {
    let called = "";
    const result = await probeHermesGateway("http://127.0.0.1:8642", {
      fetchImpl: apiServerFetch((url) => {
        if (url.endsWith("/health")) called = url;
      }),
    });
    assert.deepEqual(result, { kind: "hermes", status: 200 });
    assert.equal(called, "http://127.0.0.1:8642/health");
  });

  await t.test("does not duplicate the trailing slash", async () => {
    let called = "";
    await probeHermesGateway("http://127.0.0.1:8642/", {
      fetchImpl: apiServerFetch((url) => {
        if (url.endsWith("/health")) called = url;
      }),
    });
    assert.equal(called, "http://127.0.0.1:8642/health");
  });

  await t.test("a response that is not 200 is not-hermes", async () => {
    const result = await probeHermesGateway("http://127.0.0.1:8642", {
      fetchImpl: fakeFetch(() => new Response("nope", { status: 404 })),
    });
    assert.deepEqual(result, { kind: "not-hermes", status: 404 });
  });

  await t.test("a failed connection is unreachable", async () => {
    const result = await probeHermesGateway("http://127.0.0.1:8642", {
      fetchImpl: (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch,
    });
    assert.equal(result.kind, "unreachable");
    assert.match((result as { error: string }).error, /ECONNREFUSED/);
  });

  await t.test("a slow response times out instead of hanging", async () => {
    // This is why this probe exists — the old gateway test hung for 24 seconds
    // retrying the OpenClaw WS handshake.
    const started = Date.now();
    const result = await probeHermesGateway("http://127.0.0.1:8642", {
      timeoutMs: 30,
      fetchImpl: ((_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        })) as unknown as typeof fetch,
    });
    assert.equal(result.kind, "unreachable");
    assert.ok(Date.now() - started < 5000, "타임아웃이 걸려야 한다");
  });

  await t.test("with a profile, hits /p/<name>/health", async () => {
    let called = "";
    const result = await probeHermesGateway("http://127.0.0.1:8642", {
      profile: "sophie",
      fetchImpl: apiServerFetch((url) => {
        if (url.endsWith("/health")) called = url;
      }),
    });
    assert.deepEqual(result, { kind: "hermes", status: 200 });
    assert.equal(called, "http://127.0.0.1:8642/p/sophie/health");
  });

  await t.test("a missing profile is 404 — distinguished as not-hermes", async () => {
    // Measured: /p/nosuch/health → 404, /p/sophie/health → 200.
    const result = await probeHermesGateway("http://127.0.0.1:8642", {
      profile: "nosuch",
      fetchImpl: fakeFetch(() => new Response("no", { status: 404 })),
    });
    assert.deepEqual(result, { kind: "not-hermes", status: 404 });
  });

  await t.test("the profile name is URL-encoded", async () => {
    let called = "";
    await probeHermesGateway("http://127.0.0.1:8642", {
      profile: "a b",
      fetchImpl: apiServerFetch((url) => {
        if (url.endsWith("/health")) called = url;
      }),
    });
    assert.equal(called, "http://127.0.0.1:8642/p/a%20b/health");
  });

  await t.test("the dashboard is not hermes — /health 200 alone does not pass", async () => {
    // The false positive that blocked us the longest today. The Hermes dashboard (9119) returns 200 on /health,
    // and being an SPA catch-all it returns 200 + HTML on /v1/models too. Looking only at status codes,
    // it is indistinguishable from the real API server (8643), so the wrong port passed as "connected".
    const result = await probeHermesGateway("http://127.0.0.1:9119", {
      fetchImpl: dashboardFetch(),
    });
    assert.deepEqual(result, { kind: "dashboard", status: 200 });
  });

  await t.test("discrimination uses content-type, not the status code", async () => {
    // The dashboard also returns 200. What differs is whether the body is JSON or HTML.
    const result = await probeHermesGateway("http://127.0.0.1:8642", {
      fetchImpl: fakeFetch((url) =>
        url.endsWith("/health")
          ? new Response("ok", { status: 200 })
          : new Response("{}", {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
      ),
    });
    assert.equal(result.kind, "hermes");
  });

  await t.test("the second request also keeps the profile scope", async () => {
    const urls: string[] = [];
    await probeHermesGateway("http://127.0.0.1:8642", {
      profile: "sophie",
      fetchImpl: apiServerFetch((url) => urls.push(url)),
    });
    assert.deepEqual(urls, [
      "http://127.0.0.1:8642/p/sophie/health",
      "http://127.0.0.1:8642/p/sophie/v1/models",
    ]);
  });

  await t.test("does not say hermes if the check cannot be completed", async () => {
    // /health passed but the second request failed. Passing it as hermes here would
    // leave the very false positive we are fixing — it is hermes only with positive evidence.
    const result = await probeHermesGateway("http://127.0.0.1:8642", {
      fetchImpl: fakeFetch((url) => {
        if (url.endsWith("/health")) return new Response("ok", { status: 200 });
        throw new Error("ECONNRESET");
      }),
    });
    assert.equal(result.kind, "unreachable");
  });
});
