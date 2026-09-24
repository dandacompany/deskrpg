import assert from "node:assert/strict";
import test from "node:test";

import { APP_VERSION, compareCalVer, formatStars, isNewer } from "./app-meta";
import pkg from "../../package.json";

test("the app version is read from package.json", () => {
  assert.equal(APP_VERSION, pkg.version);
});

test("calendar-style versions compare numerically per segment", () => {
  assert.equal(compareCalVer("2026.921.3", "2026.921.10"), -1);
  assert.equal(compareCalVer("v2026.1001.0", "2026.921.3"), 1);
  assert.equal(compareCalVer("2026.921.3", "v2026.921.3"), 0);
  assert.equal(compareCalVer("nightly", "2026.921.3"), 0);
});

test("treated as not newer when the latest version is missing or unreadable", () => {
  assert.equal(isNewer("2026.922.0", "2026.921.3"), true);
  assert.equal(isNewer(null, "2026.921.3"), false);
  assert.equal(isNewer("garbage", "2026.921.3"), false);
});

test("star counts abbreviate thousands with k", () => {
  assert.equal(formatStars(999), "999");
  assert.equal(formatStars(1234), "1.2k");
  assert.equal(formatStars(12000), "12k");
});
