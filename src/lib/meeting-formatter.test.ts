import assert from "node:assert/strict";
import test from "node:test";

import { parseMention } from "./conversation/mention";

const { formatSpeakMessage, sanitizeSpokenResponse, sanitizeStreamingSpokenResponse } =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("./meeting-formatter.js") as typeof import("./meeting-formatter.js");

test("sanitizeSpokenResponse removes a leading SPEAK prefix", () => {
  assert.equal(sanitizeSpokenResponse("SPEAK: 안녕하세요"), "안녕하세요");
  assert.equal(sanitizeSpokenResponse("  SPEAK 안녕하세요"), "안녕하세요");
  assert.equal(sanitizeSpokenResponse("안녕하세요 SPEAK:"), "안녕하세요 SPEAK:");
});

test("sanitizeStreamingSpokenResponse suppresses partial SPEAK prefix fragments", () => {
  assert.equal(sanitizeStreamingSpokenResponse("SPE"), "");
  assert.equal(sanitizeStreamingSpokenResponse("SPEAK:"), "");
  assert.equal(sanitizeStreamingSpokenResponse("SPEAK: 안녕하세요"), "안녕하세요");
  assert.equal(sanitizeStreamingSpokenResponse("So"), "So");
});

test("sanitizeSpokenResponse leaves the TO: line intact (parseMention needs it)", () => {
  // conversation-engine.ts passes this function's result straight into parseMention().
  // Stripping TO: here would make mentions silently disappear — removing it for display is
  // handled only on the sanitizeStreamingSpokenResponse / stream-text.ts side.
  assert.equal(sanitizeSpokenResponse("TO: 단비\n어때요?"), "TO: 단비\n어때요?");
});

test("sanitizeStreamingSpokenResponse suppresses a growing TO: prefix until the line completes", () => {
  assert.equal(sanitizeStreamingSpokenResponse("T"), "");
  assert.equal(sanitizeStreamingSpokenResponse("TO"), "");
  assert.equal(sanitizeStreamingSpokenResponse("TO:"), "");
  assert.equal(sanitizeStreamingSpokenResponse("TO: 단비\n어때요"), "어때요");
});

test("writing in the format the mention instructions describe is actually accepted by parseMention (round trip)", () => {
  const participants = [
    { npcId: "npc-danbi", displayName: "단비", role: "팀장" },
    { npcId: "npc-sophie", displayName: "소피", role: "개발자" },
  ];

  const prompt = formatSpeakMessage(
    "점심 메뉴",
    participants.map((p) => ({ displayName: p.displayName, role: p.role })),
    [],
    { displayName: "소피" },
    1,
    20,
    5,
  );

  // Following the "TO: name" format the prompt describes — building a mention from just the
  // name, with the role stripped from the participant-list rendering (name(role)) — must be
  // recognized correctly by parseMention.
  assert.match(prompt, /TO: 이름/, "프롬프트에 TO: 이름 형식 안내가 없습니다");

  const spokenBySophie = "TO: 단비\n오늘 점심 뭐 먹을까요?";
  const mention = parseMention(spokenBySophie, participants, "npc-sophie");

  assert.equal(mention.npcId, "npc-danbi");
  assert.equal(mention.text, "오늘 점심 뭐 먹을까요?");
});
