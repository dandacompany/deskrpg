import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

import { authHeaders, seedChannel, seedUser, setupThrowawaySqlite } from "@/test-setup/npc-seed";

// Report acknowledgments moved from the browser to the server (conversation_reads, kind=report).
// Kept outside the `[id]` segment — the node test runner mistakes `[id]` for a character class.
setupThrowawaySqlite("report-acks-route-test");

async function call(method: "GET" | "POST", channelId: string, userId: string, body?: unknown) {
  const route = await import("./[id]/report-acks/route");
  const req = new NextRequest(`http://localhost/api/channels/${channelId}/report-acks`, {
    method,
    headers: { ...authHeaders(userId), "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const res = await route[method](req, { params: Promise.resolve({ id: channelId }) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test("a member reads null first, imports the browser record once, then acknowledges one report", async () => {
  const owner = await seedUser("owner");
  const channel = await seedChannel(owner.id);

  assert.deepEqual(await call("GET", channel.id, owner.id), { status: 200, body: { ack: null } });

  const imported = await call("POST", channel.id, owner.id, {
    import: { through: "2026-09-26T10:00:00.000Z", ids: ["m1"] },
  });
  assert.deepEqual(imported, {
    status: 200,
    body: { ack: { through: "2026-09-26T10:00:00.000Z", ids: ["m1"] } },
  });

  const acked = await call("POST", channel.id, owner.id, { messageId: "m2" });
  assert.deepEqual(acked.body, { ack: { through: "2026-09-26T10:00:00.000Z", ids: ["m1", "m2"] } });
  assert.deepEqual((await call("GET", channel.id, owner.id)).body, acked.body);
});

test("a non-member is refused and a malformed body is 400", async () => {
  const owner = await seedUser("owner");
  const stranger = await seedUser("stranger");
  const channel = await seedChannel(owner.id);

  assert.equal((await call("GET", channel.id, stranger.id)).status, 403);
  assert.equal((await call("POST", channel.id, stranger.id, { messageId: "m1" })).status, 403);
  for (const bad of [{}, { messageId: "" }, { import: { through: 3, ids: "x" } }])
    assert.equal((await call("POST", channel.id, owner.id, bad)).status, 400);
});
