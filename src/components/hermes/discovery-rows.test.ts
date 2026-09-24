import test from "node:test";
import assert from "node:assert/strict";

import { partitionRegistrationResults, toDiscoveryRows, toProbeStatus } from "./discovery-rows";

test("toDiscoveryRows", async (t) => {
  await t.test("selectable when it has a token, is served, and is unregistered", () => {
    const [row] = toDiscoveryRows([
      { name: "sophie", hasToken: true, servedByGateway: true, alreadyRegistered: false },
    ]);
    assert.deepEqual(row, {
      name: "sophie",
      hasToken: true,
      servedByGateway: true,
      alreadyRegistered: false,
      selectable: true,
      reason: "ok",
    });
  });

  await t.test("not selectable when already registered — that reason takes priority", () => {
    const [row] = toDiscoveryRows([
      { name: "danvi", hasToken: true, servedByGateway: true, alreadyRegistered: true },
    ]);
    assert.equal(row.selectable, false);
    assert.equal(row.reason, "already");
  });

  await t.test("not selectable when it has no token", () => {
    const [row] = toDiscoveryRows([
      { name: "ada", hasToken: false, servedByGateway: true, alreadyRegistered: false },
    ]);
    assert.equal(row.selectable, false);
    assert.equal(row.reason, "no_token");
  });

  await t.test("not selectable when the gateway does not serve it", () => {
    // Directories that look like a profile but aren't an agent, like acestep_output, land here.
    const [row] = toDiscoveryRows([
      { name: "acestep_output", hasToken: true, servedByGateway: false, alreadyRegistered: false },
    ]);
    assert.equal(row.selectable, false);
    assert.equal(row.reason, "not_served");
  });
});

test("partitionRegistrationResults", async (t) => {
  await t.test("a successful name drops out of the selection and isn't in the failure list", () => {
    const { nextSelected, failures } = partitionRegistrationResults([{ name: "sophie", ok: true }]);
    assert.deepEqual(nextSelected, []);
    assert.deepEqual(failures, []);
  });

  await t.test("a failed name stays in the selection for retry, with a reason attached", () => {
    const { nextSelected, failures } = partitionRegistrationResults([
      { name: "sophie", ok: true },
      { name: "danvi", ok: false, errorCode: "no_token" },
    ]);
    assert.deepEqual(nextSelected, ["danvi"]);
    assert.deepEqual(failures, [{ name: "danvi", errorCode: "no_token" }]);
  });

  await t.test("a failure without an errorCode collapses to register_failed", () => {
    const { nextSelected, failures } = partitionRegistrationResults([{ name: "ada", ok: false }]);
    assert.deepEqual(nextSelected, ["ada"]);
    assert.deepEqual(failures, [{ name: "ada", errorCode: "register_failed" }]);
  });
});

test("toProbeStatus", async (t) => {
  await t.test("known values pass through unchanged", () => {
    assert.equal(toProbeStatus("ok"), "ok");
    assert.equal(toProbeStatus("not_found"), "not_found");
    assert.equal(toProbeStatus("unknown"), "unknown");
    assert.equal(toProbeStatus("idle"), "idle");
  });

  await t.test("unknown strings, undefined, null, and objects collapse to unknown", () => {
    assert.equal(toProbeStatus("valid"), "unknown");
    assert.equal(toProbeStatus(undefined), "unknown");
    assert.equal(toProbeStatus(null), "unknown");
    assert.equal(toProbeStatus({ status: "ok" }), "unknown");
  });
});
