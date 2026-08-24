import test from "node:test";
import assert from "node:assert/strict";

import { probeHermesGateway } from "./gateway-probe";

function fakeFetch(impl: (url: string) => Promise<Response> | Response) {
  return ((input: RequestInfo | URL) =>
    Promise.resolve(impl(String(input)))) as unknown as typeof fetch;
}

/** 진짜 Hermes API Server 의 실측 응답. /health 는 무인증 200, /v1/models 는 401 JSON. */
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

/** Hermes 대시보드(SPA). 실측: 아무 경로에나 200 + HTML 을 돌려준다. */
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
  await t.test("/health 200이면 hermes로 판정한다", async () => {
    let called = "";
    const result = await probeHermesGateway("http://127.0.0.1:8642", {
      fetchImpl: apiServerFetch((url) => {
        if (url.endsWith("/health")) called = url;
      }),
    });
    assert.deepEqual(result, { kind: "hermes", status: 200 });
    assert.equal(called, "http://127.0.0.1:8642/health");
  });

  await t.test("끝의 슬래시를 중복시키지 않는다", async () => {
    let called = "";
    await probeHermesGateway("http://127.0.0.1:8642/", {
      fetchImpl: apiServerFetch((url) => {
        if (url.endsWith("/health")) called = url;
      }),
    });
    assert.equal(called, "http://127.0.0.1:8642/health");
  });

  await t.test("응답은 왔지만 200이 아니면 not-hermes다", async () => {
    const result = await probeHermesGateway("http://127.0.0.1:8642", {
      fetchImpl: fakeFetch(() => new Response("nope", { status: 404 })),
    });
    assert.deepEqual(result, { kind: "not-hermes", status: 404 });
  });

  await t.test("연결 자체가 실패하면 unreachable이다", async () => {
    const result = await probeHermesGateway("http://127.0.0.1:8642", {
      fetchImpl: (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch,
    });
    assert.equal(result.kind, "unreachable");
    assert.match((result as { error: string }).error, /ECONNREFUSED/);
  });

  await t.test("응답이 늦으면 타임아웃되고 매달리지 않는다", async () => {
    // 이 프로브가 존재하는 이유가 이것이다 — 옛 게이트웨이 테스트는 OpenClaw WS
    // 핸드셰이크를 재시도하며 24초를 매달렸다.
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

  await t.test("profile을 주면 /p/<이름>/health 를 찌른다", async () => {
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

  await t.test("없는 프로필은 404 — not-hermes 로 구분된다", async () => {
    // 실측: /p/nosuch/health → 404, /p/sophie/health → 200.
    const result = await probeHermesGateway("http://127.0.0.1:8642", {
      profile: "nosuch",
      fetchImpl: fakeFetch(() => new Response("no", { status: 404 })),
    });
    assert.deepEqual(result, { kind: "not-hermes", status: 404 });
  });

  await t.test("프로필 이름은 URL 인코딩된다", async () => {
    let called = "";
    await probeHermesGateway("http://127.0.0.1:8642", {
      profile: "a b",
      fetchImpl: apiServerFetch((url) => {
        if (url.endsWith("/health")) called = url;
      }),
    });
    assert.equal(called, "http://127.0.0.1:8642/p/a%20b/health");
  });

  await t.test("대시보드는 hermes 가 아니다 — /health 200 만으로 통과시키지 않는다", async () => {
    // 오늘 우리를 가장 오래 막은 오탐이다. Hermes 대시보드(9119)는 /health 에 200 을
    // 내고, SPA catch-all 이라 /v1/models 에도 200 + HTML 을 낸다. 상태 코드만 보면
    // 진짜 API 서버(8643)와 구분되지 않아, 틀린 포트가 "연결됨"으로 통과했다.
    const result = await probeHermesGateway("http://127.0.0.1:9119", {
      fetchImpl: dashboardFetch(),
    });
    assert.deepEqual(result, { kind: "dashboard", status: 200 });
  });

  await t.test("판별은 상태 코드가 아니라 content-type 으로 한다", async () => {
    // 대시보드도 200 을 낸다. 갈리는 것은 본문이 JSON 이냐 HTML 이냐다.
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

  await t.test("두 번째 요청도 프로필 스코프를 지킨다", async () => {
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

  await t.test("확인을 끝내지 못하면 hermes 라고 하지 않는다", async () => {
    // /health 는 통과했지만 두 번째 요청이 실패한 경우. 여기서 hermes 로 통과시키면
    // 지금 고치려는 오탐이 그대로 남는다 — 긍정적 증거가 있을 때만 hermes 다.
    const result = await probeHermesGateway("http://127.0.0.1:8642", {
      fetchImpl: fakeFetch((url) => {
        if (url.endsWith("/health")) return new Response("ok", { status: 200 });
        throw new Error("ECONNRESET");
      }),
    });
    assert.equal(result.kind, "unreachable");
  });
});
