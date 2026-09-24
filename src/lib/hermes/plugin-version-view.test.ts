import { test } from "node:test";
import assert from "node:assert/strict";

import { PLUGIN_VERSION } from "@/lib/hermes/setup/pin";

import { describePluginVersion } from "./plugin-version-view";

test("installed version equal to the pin is current", () => {
  // Copying the pin literal here would break this test on every plugin bump — use the constant as-is.
  const got = describePluginVersion({ installed: PLUGIN_VERSION, pluginStatus: "plugin_ready" });
  assert.equal(got.state, "current");
  assert.equal(got.installed, PLUGIN_VERSION);
  assert.equal(got.pinned, PLUGIN_VERSION);
});

test("installed version below the pin is behind — string comparison can't tell", () => {
  // With string comparison, where "0.9.0" > "0.10.2" is true, this line would not pass.
  assert.equal(
    describePluginVersion({ installed: "0.9.0", pluginStatus: "plugin_ready" }).state,
    "outdated",
  );
  assert.equal(
    describePluginVersion({ installed: "0.10.0", pluginStatus: "plugin_ready" }).state,
    "outdated",
  );
});

test("installed version above the pin is ahead — never called behind", () => {
  assert.equal(
    describePluginVersion({ installed: "99.0.0", pluginStatus: "plugin_ready" }).state,
    "ahead",
  );
});

test("unknown version is reported as unknown — a missing value is not passed off as current", () => {
  for (const installed of [null, "", "알 수 없음"]) {
    assert.equal(
      describePluginVersion({ installed, pluginStatus: "plugin_ready" }).state,
      "unknown",
      String(installed),
    );
  }
});

test("no version comparison when the plugin is not ready", () => {
  // Calling a gateway blocked by 404/401 "behind" would point at the wrong thing to fix.
  for (const status of ["plugin_absent", "plugin_unauthorized", "unknown", null]) {
    assert.equal(
      describePluginVersion({ installed: "0.10.0", pluginStatus: status }).state,
      "unknown",
      String(status),
    );
  }
});
