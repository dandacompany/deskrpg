import assert from "node:assert/strict";
import test from "node:test";
import ko from "@/lib/i18n/locales/ko";
import en from "@/lib/i18n/locales/en";
import ja from "@/lib/i18n/locales/ja";
import zh from "@/lib/i18n/locales/zh";

test("the inactive meeting CTA in the room shows 'start meeting' in all four locales", () => {
  for (const [locale, expected] of [
    [ko, "회의 시작"],
    [en, "Start meeting"],
    [ja, "会議を開始"],
    [zh, "开始会议"],
  ] as const) {
    assert.equal(locale["meeting.prepare"], expected);
    assert.notEqual(locale["meeting.prepare"], locale["meeting.join"]);
  }
});
