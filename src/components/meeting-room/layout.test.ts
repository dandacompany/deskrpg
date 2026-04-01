import assert from "node:assert/strict";
import test from "node:test";

import {
  computeMeetingTableLayout,
  getSeatFacing,
} from "./layout";

test("layout uses top and bottom rows first, then side seats", () => {
  const layout = computeMeetingTableLayout({
    participantIds: ["chair", "a", "b", "c", "d", "e", "f"],
  });

  assert.equal(layout.seats[0]?.side, "top");
  assert.ok(layout.seats.some((seat) => seat.side === "left"));
  assert.ok(layout.seats.some((seat) => seat.side === "right"));
  assert.ok(layout.table.width > layout.table.minWidth);
});

test("layout keeps medium meetings on top and bottom rows before using side seats", () => {
  const layout = computeMeetingTableLayout({
    participantIds: ["chair", "a", "b", "c", "d"],
  });

  assert.deepEqual(
    layout.seats.map((seat) => seat.side),
    ["top", "bottom", "top", "bottom", "top"],
  );
});

test("seat facing matches the side of the table", () => {
  assert.equal(getSeatFacing("top"), "front");
  assert.equal(getSeatFacing("bottom"), "back");
  assert.equal(getSeatFacing("left"), "right");
  assert.equal(getSeatFacing("right"), "left");
});
