import assert from "node:assert/strict";
import test from "node:test";

import { PLUGIN_INSTALL_COMMAND } from "@/lib/hermes/plugin-install-command";
import { classifyGateFailure, isSetupBlocker } from "./gate-failure";

test("carries the server's mapping table over as-is", () => {
  assert.deepEqual(classifyGateFailure({ status: 409, code: "gateway_not_bound" }), {
    kind: "gateway_not_bound",
  });
  assert.deepEqual(classifyGateFailure({ status: 404, code: "plugin_absent" }), {
    kind: "plugin_absent",
    command: PLUGIN_INSTALL_COMMAND,
  });
  assert.deepEqual(classifyGateFailure({ status: 401, code: "plugin_unauthorized" }), {
    kind: "plugin_unauthorized",
  });
  assert.deepEqual(classifyGateFailure({ status: 504, code: "timeout" }), { kind: "timeout" });
  assert.deepEqual(classifyGateFailure({ status: 503, code: "unreachable" }), {
    kind: "unreachable",
  });
  // plugin_unknown means the same thing to the user as unreachable — there's no information to split it into a separate stage.
  assert.deepEqual(classifyGateFailure({ status: 503, code: "plugin_unknown" }), {
    kind: "unreachable",
  });
});

test("upgrade uses the minimum version the server gave, falling back to a default if absent", () => {
  assert.deepEqual(
    classifyGateFailure({ status: 428, code: "plugin_upgrade_required", minVersion: "0.9.0" }),
    { kind: "plugin_upgrade_required", minVersion: "0.9.0", command: PLUGIN_INSTALL_COMMAND },
  );
  assert.deepEqual(classifyGateFailure({ status: 428, code: "plugin_upgrade_required" }), {
    kind: "plugin_upgrade_required",
    minVersion: "0.6.0",
    command: PLUGIN_INSTALL_COMMAND,
  });
});

test("the code comes first — the status code alone doesn't decide", () => {
  // The same 503 gives a different result with a different code.
  assert.equal(classifyGateFailure({ status: 503, code: "board_unavailable" }).kind, "other");
  // A code absent from the table is carried through as-is, along with its status code.
  assert.deepEqual(classifyGateFailure({ status: 500, code: "boom", message: "터졌다" }), {
    kind: "other",
    status: 500,
    code: "boom",
    message: "터졌다",
  });
  assert.deepEqual(classifyGateFailure({ status: 0, code: "unknown" }), {
    kind: "other",
    status: 0,
    code: "unknown",
    message: "",
  });
});

test("distinguishes values that draw the checklist from those that don't", () => {
  for (const failure of [
    { status: 409, code: "gateway_not_bound" },
    { status: 404, code: "plugin_absent" },
    { status: 401, code: "plugin_unauthorized" },
    { status: 428, code: "plugin_upgrade_required" },
  ]) {
    assert.equal(isSetupBlocker(classifyGateFailure(failure)), true, failure.code);
  }
  for (const failure of [
    { status: 503, code: "unreachable" },
    { status: 504, code: "timeout" },
    { status: 500, code: "boom" },
  ]) {
    assert.equal(isSetupBlocker(classifyGateFailure(failure)), false, failure.code);
  }
});
