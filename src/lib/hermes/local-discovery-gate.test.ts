import test from "node:test";
import assert from "node:assert/strict";

import {
  LOCAL_DISCOVERY_ENV_FLAG,
  isLocalDiscoveryEnabled,
  isLoopbackBaseUrl,
  isLoopbackHost,
  localDiscoveryAllowed,
} from "./local-discovery-gate";

test("isLoopbackHost", async (t) => {
  await t.test("스펙 §4 1단계가 열거한 네 가지", () => {
    for (const h of ["127.0.0.1", "localhost", "::1", "0.0.0.0"]) {
      assert.equal(isLoopbackHost(h), true, h);
    }
  });

  await t.test("IPv6는 대괄호가 붙은 채로 온다 — URL.hostname 의 모양", () => {
    // new URL("http://[::1]:8080").hostname === "[::1]"
    assert.equal(isLoopbackHost("[::1]"), true);
    assert.equal(isLoopbackHost("[::ffff:127.0.0.1]"), true);
    assert.equal(isLoopbackHost("[2001:db8::1]"), false);
  });

  await t.test("대소문자와 루트 라벨(.)을 흡수한다", () => {
    assert.equal(isLoopbackHost("LocalHost"), true);
    assert.equal(isLoopbackHost("localhost."), true);
  });

  await t.test("127.0.0.0/8 전체가 루프백이다", () => {
    assert.equal(isLoopbackHost("127.1.2.3"), true);
    assert.equal(isLoopbackHost("127.0.0.255"), true);
    assert.equal(isLoopbackHost("127.0.0.256"), false);
  });

  await t.test("루프백처럼 보이지만 아닌 것들", () => {
    for (const h of [
      "",
      "attacker.example",
      // 앞뒤에 뭔가 붙은 것 — 부분 일치로 통과하면 안 된다.
      "localhost.attacker.example",
      "notlocalhost",
      "127.0.0.1.attacker.example",
      "0.0.0.1",
      "128.0.0.1",
      "10.0.0.1",
      "192.168.0.1",
      // IPv6 유니크 로컬은 루프백이 아니다.
      "[fd00::1]",
    ]) {
      assert.equal(isLoopbackHost(h), false, h);
    }
  });
});

test("isLoopbackBaseUrl", async (t) => {
  await t.test("포트가 붙어도 호스트만 본다 — 흔히 틀리는 자리", () => {
    assert.equal(isLoopbackBaseUrl("http://127.0.0.1:8000"), true);
    assert.equal(isLoopbackBaseUrl("http://localhost:5555/"), true);
    assert.equal(isLoopbackBaseUrl("http://[::1]:8080/v1"), true);
    assert.equal(isLoopbackBaseUrl("https://127.0.0.1:8443"), true);
  });

  await t.test("원격 URL은 루프백이 아니다", () => {
    assert.equal(isLoopbackBaseUrl("https://attacker.example"), false);
    assert.equal(isLoopbackBaseUrl("http://gw.test:8000"), false);
  });

  await t.test("자격증명·경로에 루프백 문자열을 심어도 통과하지 않는다", () => {
    assert.equal(isLoopbackBaseUrl("http://127.0.0.1@attacker.example/"), false);
    assert.equal(isLoopbackBaseUrl("https://attacker.example/127.0.0.1"), false);
    assert.equal(isLoopbackBaseUrl("https://attacker.example/#127.0.0.1"), false);
  });

  await t.test("파싱 불가하거나 http(s)가 아니면 로컬이 아니다", () => {
    assert.equal(isLoopbackBaseUrl("not a url"), false);
    assert.equal(isLoopbackBaseUrl(""), false);
    assert.equal(isLoopbackBaseUrl("file:///etc"), false);
    assert.equal(isLoopbackBaseUrl("ws://127.0.0.1:8000"), false);
  });
});

test("isLocalDiscoveryEnabled — 기본값은 꺼짐", async (t) => {
  await t.test("설정하지 않으면 꺼져 있다", () => {
    assert.equal(isLocalDiscoveryEnabled({}), false);
    assert.equal(isLocalDiscoveryEnabled({ [LOCAL_DISCOVERY_ENV_FLAG]: "" }), false);
  });

  await t.test("명시적으로 켠 값만 통과한다", () => {
    for (const v of ["1", "true", "TRUE", "yes", "on", " true "]) {
      assert.equal(isLocalDiscoveryEnabled({ [LOCAL_DISCOVERY_ENV_FLAG]: v }), true, v);
    }
    for (const v of ["0", "false", "no", "off", "maybe"]) {
      assert.equal(isLocalDiscoveryEnabled({ [LOCAL_DISCOVERY_ENV_FLAG]: v }), false, v);
    }
  });
});

test("localDiscoveryAllowed — 두 게이트의 논리곱", async (t) => {
  const on = { [LOCAL_DISCOVERY_ENV_FLAG]: "true" };
  await t.test("둘 다 참일 때만 허용", () => {
    assert.equal(localDiscoveryAllowed({ env: on, baseUrl: "http://127.0.0.1:8000" }), true);
  });
  await t.test("스위치가 꺼져 있으면 루프백이어도 불허", () => {
    assert.equal(localDiscoveryAllowed({ env: {}, baseUrl: "http://127.0.0.1:8000" }), false);
  });
  await t.test("스위치가 켜져 있어도 원격 URL은 불허", () => {
    assert.equal(localDiscoveryAllowed({ env: on, baseUrl: "https://attacker.example" }), false);
  });
});
