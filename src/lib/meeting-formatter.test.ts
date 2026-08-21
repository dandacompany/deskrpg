import assert from "node:assert/strict";
import test from "node:test";

import { parseMention } from "./conversation/mention";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  formatSpeakMessage,
  sanitizeSpokenResponse,
  sanitizeStreamingSpokenResponse,
} = require("./meeting-formatter.js") as typeof import("./meeting-formatter.js");

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
  // conversation-engine.ts 는 이 함수의 결과를 그대로 parseMention() 에 넘긴다.
  // 여기서 TO: 를 지우면 지목이 조용히 사라진다 — 화면 표시용 제거는
  // sanitizeStreamingSpokenResponse 와 stream-text.ts 쪽에서만 한다.
  assert.equal(sanitizeSpokenResponse("TO: 단비\n어때요?"), "TO: 단비\n어때요?");
});

test("sanitizeStreamingSpokenResponse suppresses a growing TO: prefix until the line completes", () => {
  assert.equal(sanitizeStreamingSpokenResponse("T"), "");
  assert.equal(sanitizeStreamingSpokenResponse("TO"), "");
  assert.equal(sanitizeStreamingSpokenResponse("TO:"), "");
  assert.equal(sanitizeStreamingSpokenResponse("TO: 단비\n어때요"), "어때요");
});

test("멘션 안내문이 알려주는 형식대로 쓰면 parseMention이 실제로 인정한다 (round trip)", () => {
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

  // 프롬프트가 안내하는 "TO: 이름" 형식대로, 참석자 목록 렌더링(이름(역할))에서
  // 역할을 뺀 이름만 써서 멘션을 만들었을 때 parseMention이 정확히 인식해야 한다.
  assert.match(prompt, /TO: 이름/, "프롬프트에 TO: 이름 형식 안내가 없습니다");

  const spokenBySophie = "TO: 단비\n오늘 점심 뭐 먹을까요?";
  const mention = parseMention(spokenBySophie, participants, "npc-sophie");

  assert.equal(mention.npcId, "npc-danbi");
  assert.equal(mention.text, "오늘 점심 뭐 먹을까요?");
});
