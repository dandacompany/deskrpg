import assert from "node:assert/strict";
import test from "node:test";
import {
  decideResponders,
  resolveRoomAccessDecision,
  sortRooms,
  type RoomSummary,
} from "./chat-rooms-policy";

test("mention policy: only mentioned NPCs, no one if there's no mention", () => {
  assert.deepEqual(decideResponders("mention", ["a"], ["a", "b"]), ["a"]);
  assert.deepEqual(decideResponders("mention", [], ["a", "b"]), []);
});
test("members policy: every member with no mention, only the mentioned members with one", () => {
  assert.deepEqual(decideResponders("members", [], ["a", "b"]), ["a", "b"]);
  assert.deepEqual(decideResponders("members", ["b"], ["a", "b"]), ["b"]);
  assert.deepEqual(decideResponders("members", ["z"], ["a", "b"]), [], "멤버가 아닌 지명은 무시");
});
test("list: office at the top, the rest sorted by most recent message", () => {
  const r = (id: string, kind: "office" | "group", last: string | null): RoomSummary => ({
    id,
    kind,
    name: id,
    replyPolicy: "members",
    createdBy: "u",
    lastMessageAt: last,
    members: [],
  });
  const sorted = sortRooms([
    r("g1", "group", "2026-09-01"),
    r("off", "office", null),
    r("g2", "group", "2026-09-09"),
  ]);
  assert.deepEqual(
    sorted.map((x) => x.id),
    ["off", "g2", "g1"],
  );
});
test("access: not_found if missing, forbidden without channel permission, office is ok even for a non-member, group requires membership", () => {
  const office = {
    id: "o",
    channelId: "c",
    kind: "office",
    name: "office",
    replyPolicy: "mention",
    createdBy: "u",
    createdAt: new Date(),
    lastMessageAt: null,
  } as const;
  const group = { ...office, id: "g", kind: "group" } as const;
  assert.deepEqual(
    resolveRoomAccessDecision({ room: null, channelAllowed: true, isMember: true }),
    { ok: false, code: "not_found" },
  );
  assert.deepEqual(
    resolveRoomAccessDecision({ room: office, channelAllowed: false, isMember: false }),
    { ok: false, code: "forbidden" },
  );
  assert.equal(
    resolveRoomAccessDecision({ room: office, channelAllowed: true, isMember: false }).ok,
    true,
  );
  assert.deepEqual(
    resolveRoomAccessDecision({ room: group, channelAllowed: true, isMember: false }),
    { ok: false, code: "forbidden" },
  );
  assert.equal(
    resolveRoomAccessDecision({ room: group, channelAllowed: true, isMember: true }).ok,
    true,
  );
});
