import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

import { authHeaders, seedChannel, seedUser, setupThrowawaySqlite } from "@/test-setup/npc-seed";
import { DEFAULT_NPC_MOTION } from "@/lib/npc-motion-config";
import { buildOfficeEnvironment } from "@/game/three/office-environments";

// GET normalizes the meeting room map, so a valid map is needed for 200.
const office = () => buildOfficeEnvironment("agency");

// The channel's NPC walking speed — a shared channel setting, so it lives in the DB, only the owner changes it, and changes are broadcast.
setupThrowawaySqlite("channel-motion-config-test");

/** Intercept the internal broadcast to the socket server after a channel save (there is no real socket server). */
function captureEmits() {
  const original = globalThis.fetch;
  const emits: { event: string; payload: Record<string, unknown> }[] = [];
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    if (init?.body) emits.push(JSON.parse(init.body));
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  return { emits, restore: () => (globalThis.fetch = original) };
}

async function route() {
  return import("./[id]/route");
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

test("a channel with empty motion settings returns the defaults — the client does not interpret empty values", async () => {
  const owner = await seedUser("motion-owner-1");
  const channel = await seedChannel(owner.id, "걸음 채널", office());
  const { GET } = await route();
  const res = await GET(
    new NextRequest(`http://localhost/api/channels/${channel.id}`, {
      headers: authHeaders(owner.id),
    }),
    params(channel.id),
  );
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).channel.motionConfig, DEFAULT_NPC_MOTION);
});

test("when the owner changes it, it is clamped before saving and motionConfig is included in the broadcast", async () => {
  const owner = await seedUser("motion-owner-2");
  const channel = await seedChannel(owner.id, "걸음 채널 2", office());
  const { GET, PUT } = await route();
  const cap = captureEmits();
  try {
    const res = await PUT(
      new NextRequest(`http://localhost/api/channels/${channel.id}`, {
        method: "PUT",
        headers: authHeaders(owner.id),
        body: JSON.stringify({ motionConfig: { summon: 402, walk: 9999, bogus: 1 } }),
      }),
      params(channel.id),
    );
    assert.equal(res.status, 200);
    const emitted = cap.emits.find((e) => e.event === "channel:updated");
    assert.ok(emitted, "channel:updated 를 방송하지 않았습니다");
    assert.deepEqual(emitted.payload.motionConfig, {
      ...DEFAULT_NPC_MOTION,
      summon: 400,
      walk: 480,
    });
  } finally {
    cap.restore();
  }
  const read = await GET(
    new NextRequest(`http://localhost/api/channels/${channel.id}`, {
      headers: authHeaders(owner.id),
    }),
    params(channel.id),
  );
  const saved = (await read.json()).channel.motionConfig;
  assert.equal(saved.summon, 400, "5 단위로 맞춰 저장한다");
  assert.equal(saved.walk, 480, "범위 위는 잘라서 저장한다");
  assert.equal("bogus" in saved, false);
});

test("a save that does not change motion settings leaves motionConfig out of the broadcast — the old contract as is", async () => {
  const owner = await seedUser("motion-owner-3");
  const channel = await seedChannel(owner.id, "걸음 채널 3", office());
  const { PUT } = await route();
  const cap = captureEmits();
  try {
    await PUT(
      new NextRequest(`http://localhost/api/channels/${channel.id}`, {
        method: "PUT",
        headers: authHeaders(owner.id),
        body: JSON.stringify({ description: "설명만" }),
      }),
      params(channel.id),
    );
    const emitted = cap.emits.find((e) => e.event === "channel:updated");
    assert.ok(emitted);
    assert.deepEqual(Object.keys(emitted.payload).sort(), ["isPublic", "name"]);
  } finally {
    cap.restore();
  }
});

test("non-owners cannot change motion settings", async () => {
  const owner = await seedUser("motion-owner-4");
  const other = await seedUser("motion-other-4");
  const channel = await seedChannel(owner.id, "걸음 채널 4", office());
  const { GET, PUT } = await route();
  const cap = captureEmits();
  try {
    const res = await PUT(
      new NextRequest(`http://localhost/api/channels/${channel.id}`, {
        method: "PUT",
        headers: authHeaders(other.id),
        body: JSON.stringify({ motionConfig: { summon: 60 } }),
      }),
      params(channel.id),
    );
    assert.equal(res.status, 403);
  } finally {
    cap.restore();
  }
  const read = await GET(
    new NextRequest(`http://localhost/api/channels/${channel.id}`, {
      headers: authHeaders(owner.id),
    }),
    params(channel.id),
  );
  assert.equal((await read.json()).channel.motionConfig.summon, DEFAULT_NPC_MOTION.summon);
});
