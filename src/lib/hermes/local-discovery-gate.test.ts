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
  await t.test("the four listed in spec §4 step 1", () => {
    for (const h of ["127.0.0.1", "localhost", "::1", "0.0.0.0"]) {
      assert.equal(isLoopbackHost(h), true, h);
    }
  });

  await t.test("IPv6 arrives with brackets attached — the shape of URL.hostname", () => {
    // new URL("http://[::1]:8080").hostname === "[::1]"
    assert.equal(isLoopbackHost("[::1]"), true);
    assert.equal(isLoopbackHost("[::ffff:127.0.0.1]"), true);
    assert.equal(isLoopbackHost("[2001:db8::1]"), false);
  });

  await t.test("absorbs case and the root label (.)", () => {
    assert.equal(isLoopbackHost("LocalHost"), true);
    assert.equal(isLoopbackHost("localhost."), true);
  });

  await t.test("all of 127.0.0.0/8 is loopback", () => {
    assert.equal(isLoopbackHost("127.1.2.3"), true);
    assert.equal(isLoopbackHost("127.0.0.255"), true);
    assert.equal(isLoopbackHost("127.0.0.256"), false);
  });

  await t.test("things that look like loopback but are not", () => {
    for (const h of [
      "",
      "attacker.example",
      // Something attached before or after — must not pass on a partial match.
      "localhost.attacker.example",
      "notlocalhost",
      "127.0.0.1.attacker.example",
      "0.0.0.1",
      "128.0.0.1",
      "10.0.0.1",
      "192.168.0.1",
      // IPv6 unique local is not loopback.
      "[fd00::1]",
    ]) {
      assert.equal(isLoopbackHost(h), false, h);
    }
  });
});

test("isLoopbackBaseUrl", async (t) => {
  await t.test("only the host is checked even with a port — a commonly wrong spot", () => {
    assert.equal(isLoopbackBaseUrl("http://127.0.0.1:8000"), true);
    assert.equal(isLoopbackBaseUrl("http://localhost:5555/"), true);
    assert.equal(isLoopbackBaseUrl("http://[::1]:8080/v1"), true);
    assert.equal(isLoopbackBaseUrl("https://127.0.0.1:8443"), true);
  });

  await t.test("a remote URL is not loopback", () => {
    assert.equal(isLoopbackBaseUrl("https://attacker.example"), false);
    assert.equal(isLoopbackBaseUrl("http://gw.test:8000"), false);
  });

  await t.test("planting a loopback string in credentials or path does not pass", () => {
    assert.equal(isLoopbackBaseUrl("http://127.0.0.1@attacker.example/"), false);
    assert.equal(isLoopbackBaseUrl("https://attacker.example/127.0.0.1"), false);
    assert.equal(isLoopbackBaseUrl("https://attacker.example/#127.0.0.1"), false);
  });

  await t.test("unparseable or non-http(s) is not local", () => {
    assert.equal(isLoopbackBaseUrl("not a url"), false);
    assert.equal(isLoopbackBaseUrl(""), false);
    assert.equal(isLoopbackBaseUrl("file:///etc"), false);
    assert.equal(isLoopbackBaseUrl("ws://127.0.0.1:8000"), false);
  });
});

test("isLocalDiscoveryEnabled — defaults to off", async (t) => {
  await t.test("off when not set", () => {
    assert.equal(isLocalDiscoveryEnabled({}), false);
    assert.equal(isLocalDiscoveryEnabled({ [LOCAL_DISCOVERY_ENV_FLAG]: "" }), false);
  });

  await t.test("only explicitly enabled values pass", () => {
    for (const v of ["1", "true", "TRUE", "yes", "on", " true "]) {
      assert.equal(isLocalDiscoveryEnabled({ [LOCAL_DISCOVERY_ENV_FLAG]: v }), true, v);
    }
    for (const v of ["0", "false", "no", "off", "maybe"]) {
      assert.equal(isLocalDiscoveryEnabled({ [LOCAL_DISCOVERY_ENV_FLAG]: v }), false, v);
    }
  });
});

test("localDiscoveryAllowed — logical AND of the two gates", async (t) => {
  const on = { [LOCAL_DISCOVERY_ENV_FLAG]: "true" };
  await t.test("allowed only when both are true", () => {
    assert.equal(localDiscoveryAllowed({ env: on, baseUrl: "http://127.0.0.1:8000" }), true);
  });
  await t.test("switch off denies even for loopback", () => {
    assert.equal(localDiscoveryAllowed({ env: {}, baseUrl: "http://127.0.0.1:8000" }), false);
  });
  await t.test("switch on still denies a remote URL", () => {
    assert.equal(localDiscoveryAllowed({ env: on, baseUrl: "https://attacker.example" }), false);
  });
});
