import assert from "node:assert/strict";
import test from "node:test";

import { nextSelectedGatewayId, reloadAfterSave } from "./gateway-selection";

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

test("right after creation, the new gateway is chosen", () => {
  assert.equal(nextSelectedGatewayId("", rows, reloadAfterSave("b", "plugin_ready")), "b");
});

test("a new gateway whose plugin is not ready keeps the wizard and its install guidance", () => {
  for (const status of ["plugin_absent", "plugin_unauthorized", "unknown"]) {
    assert.equal(nextSelectedGatewayId("", rows, reloadAfterSave("b", status)), "", status);
  }
});

test("a preferred id missing from the list falls back to the no-auto-select rule", () => {
  assert.equal(nextSelectedGatewayId("", rows, { prefer: "gone", autoSelect: false }), "");
});

test("a periodic reload keeps the current selection", () => {
  assert.equal(nextSelectedGatewayId("a", rows, { autoSelect: false }), "a");
  assert.equal(nextSelectedGatewayId("a", rows), "a");
});
