import assert from "node:assert/strict";
import test from "node:test";

import { decideContextInvite } from "./context-invite-decision";
import type { RoomSummary } from "@/lib/chat-rooms-policy";

const groupRoom: RoomSummary = {
  id: "room-1",
  kind: "group",
  name: "그룹",
  replyPolicy: "members",
  createdBy: "u1",
  lastMessageAt: null,
  members: [],
};

const officeRoom: RoomSummary = {
  ...groupRoom,
  id: "room-office",
  kind: "office",
};

test("when the panel is visible and it is a group room, invite into that room", () => {
  const decision = decideContextInvite({ visible: true, currentRoom: groupRoom });
  assert.deepEqual(decision, { kind: "invite", roomId: "room-1" });
});

test("even for a group room, compose a new one when the panel is collapsed", () => {
  const decision = decideContextInvite({ visible: false, currentRoom: groupRoom });
  assert.deepEqual(decision, { kind: "compose" });
});

test("even with the panel visible, compose a new one for the office room", () => {
  const decision = decideContextInvite({ visible: true, currentRoom: officeRoom });
  assert.deepEqual(decision, { kind: "compose" });
});

test("compose a new one when there is no current room", () => {
  const decision = decideContextInvite({ visible: true, currentRoom: null });
  assert.deepEqual(decision, { kind: "compose" });
});

const groupRoomWithSophie: RoomSummary = {
  ...groupRoom,
  members: [{ kind: "npc", id: "npc-sophie", name: "소피" }],
};

test("inviting an NPC who is already a member of the room reports already-member (M-5)", () => {
  const decision = decideContextInvite({
    visible: true,
    currentRoom: groupRoomWithSophie,
    npcId: "npc-sophie",
  });
  assert.deepEqual(decision, { kind: "already-member", roomId: "room-1" });
});

test("an NPC who is not a member is invited as is (M-5)", () => {
  const decision = decideContextInvite({
    visible: true,
    currentRoom: groupRoomWithSophie,
    npcId: "npc-other",
  });
  assert.deepEqual(decision, { kind: "invite", roomId: "room-1" });
});
