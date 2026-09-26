import assert from "node:assert/strict";
import test from "node:test";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const formatter = require("./meeting-formatter.js") as typeof import("./meeting-formatter.js");

const HANGUL = /[가-힣]/;
const turns = [{ displayName: "A", content: "hi" }];
const participants = [{ displayName: "A", role: "Lead" }];
const NON_KO = ["en", "ja", "zh", null];

for (const locale of NON_KO) {
  test(`the ${String(locale)} poll message uses the English template`, () => {
    const message = formatter.formatPollMessage(
      "Topic",
      turns,
      { displayName: "A" },
      2,
      10,
      3,
      "Be brief",
      locale,
    );
    assert.ok(message.startsWith("📋 [Meeting poll: Topic]\n"));
    assert.ok(message.includes("Turn: 2/10 | Your remaining turns: 3"));
    assert.ok(message.includes("[Speaking guideline] Be brief"));
    assert.ok(message.endsWith("Answer with exactly one of SPEAK: or PASS on the first line."));
    assert.equal(HANGUL.test(message), false);
  });

  test(`the ${String(locale)} speak message uses the English template`, () => {
    const message = formatter.formatSpeakMessage(
      "Topic",
      participants,
      turns,
      { displayName: "A" },
      2,
      10,
      3,
      locale,
    );
    assert.ok(message.startsWith("📋 [Meeting: Topic]\nParticipants: A(Lead)\n"));
    assert.ok(message.includes("A, please share your view."));
    assert.ok(message.includes('"TO: Name"'));
    assert.equal(HANGUL.test(message), false);
  });

  test(`the ${String(locale)} transcript uses English headings`, () => {
    const transcript = formatter.generateTranscript(
      "Topic",
      [{ seq: 1, displayName: "A", content: "hi", timestamp: 0 }],
      participants,
      locale,
    );
    assert.ok(transcript.startsWith("# Meeting minutes: Topic\n"));
    assert.ok(transcript.includes("- **Participants**: A(Lead)"));
    assert.ok(transcript.includes("## Conversation"));
    assert.equal(HANGUL.test(transcript), false);
  });

  test(`the ${String(locale)} empty SPEAK reason is English`, () => {
    assert.deepEqual(formatter.parseHandRaise("SPEAK", locale), {
      wantsToSpeak: true,
      reason: "(wants to speak)",
    });
  });
}

test("the transcript time follows the locale outside Korean", () => {
  const transcript = formatter.generateTranscript(
    "Topic",
    [{ seq: 1, displayName: "A", content: "hi", timestamp: 0 }],
    participants,
    "ja",
  );
  assert.ok(transcript.includes(`(${new Date(0).toLocaleTimeString("ja", { timeZone: "UTC" })})`));
});

test("passing ko explicitly matches the default Korean output", () => {
  const args = ["Topic", turns, { displayName: "A" }, 2, 10, 3, null] as const;
  assert.equal(formatter.formatPollMessage(...args, "ko"), formatter.formatPollMessage(...args));
  assert.equal(formatter.formatPollMessage(...args, "ko-KR"), formatter.formatPollMessage(...args));
});
