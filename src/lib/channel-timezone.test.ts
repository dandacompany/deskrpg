import assert from "node:assert/strict";
import test from "node:test";

import { timeZoneFromPluginInfo } from "./channel-timezone";

test("reads the Hermes timezone from the cached plugin info", () => {
  const json = JSON.stringify({ plugin: "deskrpg", version: "0.18.1", timezone: "Asia/Seoul" });
  assert.equal(timeZoneFromPluginInfo(json), "Asia/Seoul");
});

test("no cache, an old plugin without the field, or a broken cache gives no timezone", () => {
  for (const json of [
    null,
    undefined,
    "",
    "{not json",
    JSON.stringify({ plugin: "deskrpg", version: "0.5.0" }),
  ]) {
    assert.equal(timeZoneFromPluginInfo(json), null, String(json));
  }
});
