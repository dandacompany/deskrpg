import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { mapPluginFailure } from "./plugin-errors";
import { proxyFailureBody } from "./profile-proxy";

const failure = (code: string, message = "") => ({
  code,
  message,
  blocksEditor: false,
  showsShellCommand: null,
  details: {},
});

describe("profile proxy failure body", () => {
  it("turns a route-missing 404 into an upgrade hint", () => {
    const got = proxyFailureBody({ status: 404, failure: failure("upstream_error", "Not Found") });
    assert.equal(got.errorCode, "plugin_upgrade_required");
    assert.deepEqual(got.body.details, { minVersion: "0.9.0", reason: "missing_route" });
  });
  it("passes through a 404 reported by the plugin as-is", () => {
    const got = proxyFailureBody({ status: 404, failure: failure("profile_not_found", "noah") });
    assert.equal(got.errorCode, "profile_not_found");
    assert.equal(got.body.upstreamStatus, 404);
  });
  it("passes through code, message and status for other failures", () => {
    const got = proxyFailureBody({
      status: 409,
      failure: failure("config_unreadable", "bad yaml"),
    });
    assert.deepEqual(got.body, {
      errorCode: "config_unreadable",
      error: "bad yaml",
      upstreamStatus: 409,
    });
  });
  it("Hermes multiplex's 'unknown profile' 404 is profile_not_found, not an upgrade", () => {
    // The body exactly as emitted by gateway/platforms/api_server.py profile_prefix_middleware.
    const failed = mapPluginFailure({
      status: 404,
      body: { error: "Unknown or unconfigured profile" },
    })!;
    const got = proxyFailureBody({ status: 404, failure: failed });
    assert.equal(got.errorCode, "profile_not_found");
    assert.equal(got.body.errorCode, "profile_not_found");
    assert.equal(got.body.upstreamStatus, 404);
    assert.equal(got.body.details, undefined);
  });
});
