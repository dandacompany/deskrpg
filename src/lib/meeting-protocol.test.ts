import assert from "node:assert/strict";
import test from "node:test";
import { getDefaultMeetingProtocol } from "./meeting-protocol";

const HANGUL = /[가-힣]/;

for (const locale of ["en", "ja", "zh", null, undefined, "fr"]) {
  test(`the ${String(locale)} default protocol teaches the English meeting markers without any Korean`, () => {
    const protocol = getDefaultMeetingProtocol(locale);
    assert.equal(HANGUL.test(protocol), false);
    assert.ok(protocol.includes("📋 [Meeting poll:"));
    assert.ok(protocol.includes("📋 [Meeting:"));
    assert.ok(protocol.includes("SPEAK: (one-line reason)"));
  });
}

test("the Korean default protocol teaches the Korean meeting markers", () => {
  const protocol = getDefaultMeetingProtocol("ko");
  assert.ok(protocol.includes("📋 [회의 알림:"));
  assert.ok(protocol.includes("## 응답 언어 계약"));
});

test("the response-language contract follows the locale", () => {
  assert.ok(getDefaultMeetingProtocol("ja").includes("## 応答言語ルール"));
  assert.ok(getDefaultMeetingProtocol("zh").includes("## 回复语言约束"));
  assert.ok(getDefaultMeetingProtocol(null).includes("## Response Language Contract"));
});

// The default protocol is procedure for the system-instruction layer, never task procedure that
// could leak into a stored persona (the contract npc-persona-purity.test.ts used to pin).
test("the default protocol carries no task procedure text", () => {
  for (const locale of ["ko", "en"]) {
    assert.equal(getDefaultMeetingProtocol(locale).includes("Task Management Protocol"), false);
  }
});
