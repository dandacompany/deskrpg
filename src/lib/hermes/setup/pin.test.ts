import test from "node:test";
import assert from "node:assert/strict";

import { HOST_HELPER } from "./host-helper";
import { PLUGIN_PIN, PLUGIN_PIN_SHORT, PLUGIN_VERSION } from "./pin";

test("the host script's pinned commit matches the constant the UI reads", () => {
  // If the two diverge, the UI points to the old commit while actually installing something else.
  assert.ok(HOST_HELPER.includes(`PIN = '${PLUGIN_PIN}'`), "host-helper 의 PIN 이 다르다");
  assert.ok(
    HOST_HELPER.includes(`PLUGIN_VERSION = '${PLUGIN_VERSION}'`),
    "host-helper 의 PLUGIN_VERSION 이 다르다",
  );
});

test("the short form is the first 12 characters of the pinned commit", () => {
  assert.equal(PLUGIN_PIN_SHORT, PLUGIN_PIN.slice(0, 12));
  assert.match(PLUGIN_PIN, /^[0-9a-f]{40}$/);
});
