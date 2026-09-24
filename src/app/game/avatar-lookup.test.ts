import assert from "node:assert/strict";
import test from "node:test";

import { createAvatarLookup } from "./avatar-lookup";

const lookup = createAvatarLookup(
  [
    { id: "npc-1", name: "noah", appearance: { officeLookId: "office-tae" } },
    { id: "npc-2", name: "sophie", appearance: { officeLookId: "office-jun" } },
  ],
  [
    { userId: "u1", name: "단테", appearance: { officeLookId: "office-min" } },
    { userId: null, name: "손님", appearance: { officeLookId: "office-guest" } },
  ],
);

test("looks up by id first — gives the right appearance even if the name changed", () => {
  assert.deepEqual(lookup({ kind: "npc", id: "npc-1", name: "옛이름" }), {
    officeLookId: "office-tae",
  });
  assert.deepEqual(lookup({ kind: "user", id: "u1", name: "옛닉네임" }), {
    officeLookId: "office-min",
  });
});

test("without an id it looks up by name — old messages have no senderId", () => {
  assert.deepEqual(lookup({ kind: "npc", id: null, name: "sophie" }), {
    officeLookId: "office-jun",
  });
  assert.deepEqual(lookup({ kind: "user", name: "손님" }), { officeLookId: "office-guest" });
});

test("does not mix employees and people — same name but different kind means someone else", () => {
  assert.equal(lookup({ kind: "user", name: "noah" }), null);
  assert.equal(lookup({ kind: "npc", name: "단테" }), null);
});

test("null when not found — the avatar falls back to the default display", () => {
  assert.equal(lookup({ kind: "npc", id: "npc-없음", name: "없는직원" }), null);
});
