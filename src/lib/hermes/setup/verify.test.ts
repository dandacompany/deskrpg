import test from "node:test";
import assert from "node:assert/strict";
import { verifySetupGateway } from "./verify";
const json = (body: unknown, status = 200) => Response.json(body, { status });
test("only verified Hermes identity receives credentials; redirects forbidden", async () => {
  const seen: RequestInit[] = [];
  const fake = async (_url: unknown, options?: RequestInit) => {
    seen.push(options!);
    return json({ status: "ok" });
  };
  await assert.rejects(
    verifySetupGateway("http://gateway", "secret", fake as typeof fetch),
    /gateway_not_hermes/,
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0].headers, undefined);
  assert.equal(seen[0].redirect, "error");
});
test("plugin absent and plugin unauthorized remain distinct", async () => {
  for (const status of [404, 401]) {
    const responses = [json({ platform: "hermes-agent" }), json({ data: [] }), json({}, status)];
    const fake = async (_url: unknown, options?: RequestInit) => {
      assert.equal(options?.redirect, "error");
      return responses.shift()!;
    };
    const result = await verifySetupGateway("http://gateway", "secret", fake as typeof fetch);
    assert.equal(result.status, status === 404 ? "plugin_absent" : "plugin_unauthorized");
  }
});
test("reject bad API credential before calling plugin route", async () => {
  const responses = [json({ platform: "hermes-agent" }), json({}, 401)];
  await assert.rejects(
    verifySetupGateway("http://gateway", "secret", (async () =>
      responses.shift()!) as typeof fetch),
    /gateway_unauthorized/,
  );
  assert.equal(responses.length, 0);
});
test("the plugin_ready verdict comes with the automation contract block (info) — the setup wizard caches it (T4)", async () => {
  const responses = [
    json({ platform: "hermes-agent" }),
    json({ data: [] }),
    json({ plugin: "deskrpg", version: "0.6.0", capabilities: ["kanban", "cron", "events"] }),
  ];
  const result = await verifySetupGateway("http://gateway", "secret", (async () =>
    responses.shift()!) as typeof fetch);
  assert.equal(result.status, "plugin_ready");
  assert.equal(result.version, "0.6.0");
  assert.deepEqual(result.info?.capabilities, ["kanban", "cron", "events"]);
});
