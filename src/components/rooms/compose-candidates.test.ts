import assert from "node:assert/strict";
import test from "node:test";

import { candidatesForInvite } from "./compose-candidates";
import type { RoomSummary } from "@/lib/chat-rooms-policy";

const room: RoomSummary = {
  id: "g1",
  kind: "group",
  name: "기획",
  replyPolicy: "members",
  createdBy: "u1",
  lastMessageAt: null,
  members: [
    { kind: "npc", id: "a", name: "소피" },
    { kind: "user", id: "u2", name: "제인" },
  ],
};

const npcs = [
  { id: "a", name: "소피" },
  { id: "b", name: "올리버" },
];
const users = [
  { id: "u2", name: "제인", online: true },
  { id: "u3", name: "단테", online: true },
];

test("NPCs and people who are already members are excluded from invite candidates", () => {
  const got = candidatesForInvite(room, npcs, users);
  assert.deepEqual(
    got.npcs.map((npc) => npc.id),
    ["b"],
  );
  assert.deepEqual(
    got.users.map((user) => user.id),
    ["u3"],
  );
});

test("Not filtered out when kind differs even with the same id", () => {
  // NPC "u2" only happens to share an id with member u2; it's a different entity.
  const got = candidatesForInvite(room, [{ id: "u2", name: "동명이인" }], []);
  assert.deepEqual(
    got.npcs.map((npc) => npc.id),
    ["u2"],
  );
});

test("Returns candidates as-is when there is no room (creating a new room)", () => {
  const got = candidatesForInvite(null, npcs, users);
  assert.equal(got.npcs.length, 2);
  assert.equal(got.users.length, 2);
});

test("Given selfUserId, the user themself is excluded from new room candidates (M-6)", () => {
  const got = candidatesForInvite(null, npcs, users, "u3");
  assert.deepEqual(
    got.users.map((user) => user.id),
    ["u2"],
    "본인(u3)이 빠져야 한다",
  );
  assert.equal(got.npcs.length, 2, "NPC 후보는 영향받지 않는다");
});

test("selfUserId applies together with the existing member filter (M-6)", () => {
  const got = candidatesForInvite(room, npcs, users, "u3");
  assert.deepEqual(
    got.users.map((user) => user.id),
    [],
    "u2 는 멤버라 빠지고 u3 는 본인이라 빠진다",
  );
});
