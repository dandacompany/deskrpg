import assert from "node:assert/strict";
import test from "node:test";

import { showGatewayPicker } from "./gateway-picker-visibility";

test("the picker is shown only when there are two or more gateways", () => {
  assert.equal(showGatewayPicker(0), false);
  assert.equal(showGatewayPicker(1), false);
  assert.equal(showGatewayPicker(2), true);
});
