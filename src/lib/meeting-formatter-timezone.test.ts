/**
 * The transcript is stored as text and read back as is (minutes viewer, export, summarizer), so
 * its times are fixed when it is written. The server runs in UTC containers — times must follow
 * the channel's Hermes timezone, not the process clock.
 */
import assert from "node:assert/strict";
import test from "node:test";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const formatter = require("./meeting-formatter.js") as typeof import("./meeting-formatter.js");

process.env.TZ = "UTC";

const participants = [{ displayName: "A", role: "Lead" }];
// 2026-09-26 10:18:44 in Seoul.
const AT = Date.UTC(2026, 8, 26, 1, 18, 44);
const turn = (timestamp: number) => [{ seq: 1, displayName: "A", content: "hi", timestamp }];
const clock = (ms: number, timeZone: string, locale: string) =>
  new Date(ms).toLocaleTimeString(locale, { timeZone });

test("turn times follow the given timezone, not the server clock", () => {
  const ko = formatter.generateTranscript("Topic", turn(AT), participants, "ko", "Asia/Seoul");
  assert.ok(ko.includes(`### [1] A (${clock(AT, "Asia/Seoul", "ko-KR")})`), ko);
  assert.match(ko, /10:18:44/);
  assert.doesNotMatch(ko, /1:18:44/);
  const en = formatter.generateTranscript("Topic", turn(AT), participants, "en", "Asia/Seoul");
  assert.ok(en.includes(`(${clock(AT, "Asia/Seoul", "en")})`), en);
});

test("the date line is the meeting day in that timezone and names the zone", () => {
  // 00:30 on 2026-09-27 in Seoul is still 2026-09-26 in UTC.
  const late = Date.UTC(2026, 8, 26, 15, 30);
  const ko = formatter.generateTranscript("Topic", turn(late), participants, "ko", "Asia/Seoul");
  assert.ok(ko.includes("- **일시**: 2026-09-27 (Asia/Seoul)"), ko);
  const en = formatter.generateTranscript("Topic", turn(late), participants, "en", "Asia/Seoul");
  assert.ok(en.includes("- **Date**: 2026-09-27 (Asia/Seoul)"), en);
});

test("without a usable timezone the times are UTC and say so", () => {
  for (const zone of [null, undefined, "", "Not/AZone"]) {
    const ko = formatter.generateTranscript("Topic", turn(AT), participants, "ko", zone);
    assert.ok(ko.includes("- **일시**: 2026-09-26 (UTC)"), `${String(zone)}\n${ko}`);
    assert.ok(ko.includes(`(${clock(AT, "UTC", "ko-KR")})`), String(zone));
  }
});
