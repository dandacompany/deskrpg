import test from "node:test";
import assert from "node:assert/strict";
import { OFFICE_ROOMS } from "./office-room-layout";
import { studioReviewRooms } from "./studio-review";
import { roomLabel, untranslatedRoomLabels } from "./room-labels";

const allLabels = [
  ...Object.values(OFFICE_ROOMS).flatMap((rooms) => rooms.map((room) => room.label)),
  ...studioReviewRooms.map((room) => room.label),
];

test("every room and zone label has en/ja/zh translations", () => {
  assert.ok(allLabels.length > 10);
  assert.deepEqual(untranslatedRoomLabels(allLabels), []);
});

test("roomLabel keeps ko and translates the rest without Hangul", () => {
  assert.equal(roomLabel("탕비실", "ko"), "탕비실");
  assert.equal(roomLabel("탕비실", null), "Pantry");
  for (const label of allLabels)
    for (const locale of ["en", "ja", "zh"])
      assert.doesNotMatch(roomLabel(label, locale), /[가-힣]/, `${label} ${locale}`);
});
