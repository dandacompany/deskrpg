import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

import { authHeaders, seedGateway, seedUser, setupThrowawaySqlite } from "@/test-setup/npc-seed";

// An employee's persona (SOUL) and AI model live on the profile and show in every office the
// gateway is bound to, so changing them is the gateway owner's call (2026-09-26 decision). A user
// the gateway is only shared with can still read them (403 on write only); someone with no access
// learns nothing (404). Refused writes never reach the plugin.
setupThrowawaySqlite("profile-persona-owner-only-test");

async function startPlugin() {
  const writes: string[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.method !== "GET") writes.push(`${req.method} ${req.url}`);
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url?.endsWith("/deskrpg/identity")) {
        res.end(
          JSON.stringify(
            req.method === "GET"
              ? { body: "persona", isDefaultTemplate: false, revision: "r1" }
              : { revision: "r2" },
          ),
        );
      } else {
        res.end(JSON.stringify({ model: "gpt-5.4-mini", provider: "copilot" }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("bind failed");
  server.unref();
  return { baseUrl: `http://127.0.0.1:${address.port}`, writes };
}

async function fixture() {
  const plugin = await startPlugin();
  const owner = await seedUser("owner");
  const gateway = await seedGateway(owner.id, plugin.baseUrl);
  const { registerHermesProfile } = await import("@/lib/hermes-profiles");
  await registerHermesProfile({
    userId: owner.id,
    gatewayId: gateway.id,
    profileName: "sophie",
    token: "sophie-key-1234567890",
  });
  const { createGatewayShare } = await import("@/lib/gateway-resources");
  const shared = await seedUser("shared");
  await createGatewayShare({
    ownerUserId: owner.id,
    gatewayId: gateway.id,
    targetLoginId: shared.loginId,
  });
  const stranger = await seedUser("stranger");
  return {
    plugin,
    gatewayId: gateway.id,
    ownerId: owner.id,
    sharedId: shared.id,
    strangerId: stranger.id,
  };
}

const ctx = (id: string) => ({ params: Promise.resolve({ id, name: "sophie" }) });

async function call(
  kind: "identity" | "config",
  method: "GET" | "PUT",
  gatewayId: string,
  userId: string,
) {
  const mod =
    kind === "identity"
      ? await import("./[id]/plugin/profiles/[name]/identity/route")
      : await import("./[id]/plugin/profiles/[name]/config/route");
  const body =
    kind === "identity" ? { body: "new persona", ifRevision: "r1" } : { model: "gpt-5.4" };
  const req = new NextRequest(
    `http://localhost/api/gateways/${gatewayId}/plugin/profiles/sophie/${kind}`,
    {
      method,
      headers: authHeaders(userId),
      ...(method === "PUT" ? { body: JSON.stringify(body) } : {}),
    },
  );
  const res =
    method === "GET" ? await mod.GET(req, ctx(gatewayId)) : await mod.PUT(req, ctx(gatewayId));
  assert.ok(res, "the handler answers");
  return res;
}

for (const kind of ["identity", "config"] as const) {
  test(`${kind} PUT: owner 200, shared user 403, no access 404 — refusals never reach the plugin`, async () => {
    const f = await fixture();
    const shared = await call(kind, "PUT", f.gatewayId, f.sharedId);
    assert.equal(shared.status, 403);
    assert.equal((await shared.json()).errorCode, "forbidden");
    assert.equal((await call(kind, "PUT", f.gatewayId, f.strangerId)).status, 404);
    assert.deepEqual(f.plugin.writes, []);
    assert.equal((await call(kind, "PUT", f.gatewayId, f.ownerId)).status, 200);
    assert.equal(f.plugin.writes.length, 1);
  });

  test(`${kind} GET stays open to a shared user`, async () => {
    const f = await fixture();
    assert.equal((await call(kind, "GET", f.gatewayId, f.sharedId)).status, 200);
    assert.equal((await call(kind, "GET", f.gatewayId, f.strangerId)).status, 404);
  });
}
