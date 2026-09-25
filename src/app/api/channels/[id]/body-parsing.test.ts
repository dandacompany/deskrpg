import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";

import { authHeaders, seedChannelWithProfiles, setupThrowawaySqlite } from "@/test-setup/npc-seed";

setupThrowawaySqlite("channel-body-parsing-test");

async function put(body: string) {
  const { channelId, userId } = await seedChannelWithProfiles({});
  const { PUT } = await import("./route");
  return PUT(
    new NextRequest(`http://localhost/api/channels/${channelId}`, {
      method: "PUT",
      headers: authHeaders(userId),
      body,
    }),
    { params: Promise.resolve({ id: channelId }) },
  );
}

for (const [name, body] of [
  ["a non-JSON body", "name=x"],
  ["a JSON array", "[]"],
  ["a non-string name", JSON.stringify({ name: 7 })],
  ["a non-string description", JSON.stringify({ description: { text: "x" } })],
] as const) {
  test(`updating a channel with ${name} is 400 invalid_request_body`, async () => {
    const res = await put(body);

    assert.equal(res.status, 400);
    assert.equal((await res.json()).errorCode, "invalid_request_body");
  });
}

test("clearing a channel description with null still works", async () => {
  const res = await put(JSON.stringify({ description: null }));

  assert.equal(res.status, 200);
});
