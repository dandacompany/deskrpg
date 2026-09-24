import assert from "node:assert/strict";
import test from "node:test";

import { nextSelectedGatewayId } from "./gateway-selection";

const rows = [{ id: "a" }, { id: "b" }];

test("with an empty selection it picks the first gateway by default", () => {
  assert.equal(nextSelectedGatewayId("", rows), "a");
});

test("keeps the current selection if it is in the list", () => {
  assert.equal(nextSelectedGatewayId("b", rows), "b");
});

test("keeps an empty selection when autoSelect is off — so the connection wizard's guidance does not disappear", () => {
  assert.equal(nextSelectedGatewayId("", rows, { autoSelect: false }), "");
});

test("a vanished selection is cleared even when autoSelect is off", () => {
  assert.equal(nextSelectedGatewayId("gone", rows, { autoSelect: false }), "");
});
