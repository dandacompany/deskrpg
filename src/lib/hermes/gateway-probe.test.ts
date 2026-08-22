import test from "node:test";
import assert from "node:assert/strict";

import { probeHermesGateway } from "./gateway-probe";

function fakeFetch(impl: (url: string) => Promise<Response> | Response) {
  return ((input: RequestInfo | URL) =>
    Promise.resolve(impl(String(input)))) as unknown as typeof fetch;
}

test("probeHermesGateway", async (t) => {
  await t.test("/health 200이면 hermes로 판정한다", async () => {
    let called = "";
    const result = await probeHermesGateway("http://127.0.0.1:8642", {
      fetchImpl: fakeFetch((url) => {
        called = url;
        return new Response("ok", { status: 200 });
      }),
    });
    assert.deepEqual(result, { kind: "hermes", status: 200 });
    assert.equal(called, "http://127.0.0.1:8642/health");
  });

  await t.test("끝의 슬래시를 중복시키지 않는다", async () => {
    let called = "";
    await probeHermesGateway("http://127.0.0.1:8642/", {
      fetchImpl: fakeFetch((url) => {
        called = url;
        return new Response("ok", { status: 200 });
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
      fetchImpl: fakeFetch((url) => {
        called = url;
        return new Response("ok", { status: 200 });
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
      fetchImpl: fakeFetch((url) => {
        called = url;
        return new Response("ok", { status: 200 });
      }),
    });
    assert.equal(called, "http://127.0.0.1:8642/p/a%20b/health");
  });
});
