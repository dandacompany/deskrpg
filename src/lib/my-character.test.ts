import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { seedUser } from "@/test-setup/npc-seed";

async function loadDb() {
  return import("@/db");
}

test("getMyCharacter picks the earliest character", async () => {
  const { db, characters, isPostgres } = await loadDb();
  const { getMyCharacter } = await import("./my-character");
  const user = await seedUser("me");
  const earlier = isPostgres ? new Date("2026-01-01T00:00:00Z") : "2026-01-01T00:00:00.000Z";
  const later = isPostgres ? new Date("2026-02-01T00:00:00Z") : "2026-02-01T00:00:00.000Z";
  await db.insert(characters).values({
    userId: user.id,
    name: "둘째",
    appearance: JSON.stringify({ officeLookId: "look-1", bodyType: "male" }),
    createdAt: later as unknown as Date,
  });
  await db.insert(characters).values({
    userId: user.id,
    name: "첫째",
    appearance: JSON.stringify({ officeLookId: "look-1", bodyType: "male" }),
    createdAt: earlier as unknown as Date,
  });
  const mine = await getMyCharacter(user.id);
  assert.equal(mine?.name, "첫째");
});

test("when createdAt ties, the smaller id is me — same character on every call", async () => {
  const { db, characters, isPostgres } = await loadDb();
  const { getMyCharacter } = await import("./my-character");
  const user = await seedUser("tie");
  const same = isPostgres ? new Date("2026-03-01T00:00:00Z") : "2026-03-01T00:00:00.000Z";
  const appearance = JSON.stringify({ officeLookId: "look-1", bodyType: "male" });
  const [smallId, bigId] = [randomUUID(), randomUUID()].sort();
  // Insert order is reversed relative to id order — relying on insert order (rowid) would pick the "later" one.
  await db.insert(characters).values({
    id: bigId,
    userId: user.id,
    name: "큰 id",
    appearance,
    createdAt: same as unknown as Date,
  });
  await db.insert(characters).values({
    id: smallId,
    userId: user.id,
    name: "작은 id",
    appearance,
    createdAt: same as unknown as Date,
  });
  assert.equal((await getMyCharacter(user.id))?.name, "작은 id");
});

test("null when there is none; ensureMyCharacter creates one from the nickname", async () => {
  const { getMyCharacter, ensureMyCharacter } = await import("./my-character");
  const user = await seedUser("fresh");
  assert.equal(await getMyCharacter(user.id), null);
  const made = await ensureMyCharacter(user.id, "단테");
  assert.equal(made.name, "단테");
  const again = await ensureMyCharacter(user.id, "다른이름");
  assert.equal(again.id, made.id, "두 번째 호출은 새로 만들지 않는다");
});

test("isMyCharacter is true only for mine", async () => {
  const { isMyCharacter } = await import("./my-character");
  const mine = { id: "c1", name: "나", bio: null, appearance: {} };
  assert.equal(isMyCharacter(mine, "c1"), true);
  assert.equal(isMyCharacter(mine, "c2"), false);
  assert.equal(isMyCharacter(null, "c1"), false);
});
