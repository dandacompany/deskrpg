import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyGatewayHost } from "./gateway-host-target";

test("a loopback address is this server's host", () => {
  assert.deepEqual(classifyGatewayHost("http://127.0.0.1:8642"), { mode: "local", port: 8642 });
  assert.deepEqual(classifyGatewayHost("http://localhost:8642/"), { mode: "local", port: 8642 });
});

test("an SSH-registered address must recover its host id — here we only classify it as ssh", () => {
  const url = `http://${"a".repeat(64)}.deskrpg-ssh.invalid`;
  assert.deepEqual(classifyGatewayHost(url), { mode: "ssh" });
});

test("any other address is not a host we can manage", () => {
  // Common in container deployments — Hermes lives on the host and we cannot run on that host.
  assert.deepEqual(classifyGatewayHost("http://host.docker.internal:8642"), {
    mode: "unsupported",
  });
  assert.deepEqual(classifyGatewayHost("https://hermes.example.com"), { mode: "unsupported" });
  assert.deepEqual(classifyGatewayHost("not a url"), { mode: "unsupported" });
});

test("no port means not local — a gateway always has a port", () => {
  assert.deepEqual(classifyGatewayHost("http://127.0.0.1"), { mode: "unsupported" });
});
