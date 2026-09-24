import test from "node:test";
import assert from "node:assert/strict";

import { fetchChannelNpcs } from "./npc-prefetch";

function stubFetch(res: { ok: boolean; status: number; body?: unknown }) {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return {
      ok: res.ok,
      status: res.status,
      json: async () => res.body ?? {},
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test("with a channel it calls with channelId and returns the list", async () => {
  const { impl, calls } = stubFetch({
    ok: true,
    status: 200,
    body: { npcs: [{ id: "n1", name: "올리버", positionX: 3, positionY: 4, direction: "down" }] },
  });

  const result = await fetchChannelNpcs("ch-1", impl);

  assert.deepEqual(calls, ["/api/npcs?channelId=ch-1"]);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.npcs.length, 1);
});

test("with an empty channel it does not call at all — /api/npcs without a channel is 400", async () => {
  const { impl, calls } = stubFetch({ ok: true, status: 200, body: { npcs: [] } });

  const result = await fetchChannelNpcs("", impl);

  assert.deepEqual(calls, [], "채널 없이 /api/npcs 를 부르면 안 된다");
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, "no-channel");
});

test("does not swallow 4xx as an empty list — returns a failure carrying the status", async () => {
  // This is the heart of the regression. The old code was `data.npcs || []`, so a 400 response
  // was drawn as "0 NPCs" and the user saw no error at all.
  const { impl } = stubFetch({
    ok: false,
    status: 400,
    body: { errorCode: "channel_id_required" },
  });

  const result = await fetchChannelNpcs("ch-1", impl);

  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, "http-error");
  assert.match(!result.ok ? result.message : "", /400/);
});

test("reports a failure even when fetch itself blows up", async () => {
  const impl = (async () => {
    throw new Error("boom");
  }) as unknown as typeof fetch;

  const result = await fetchChannelNpcs("ch-1", impl);

  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, "network-error");
  assert.equal(!result.ok && result.message, "boom");
});
