import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { formatOpenChatMessage } from "./open-chat-formatter";

describe("formatOpenChatMessage", () => {
  const self = { displayName: "단비" };
  const others = [
    { displayName: "하늘", role: "디자이너" },
    { displayName: "바다", role: "개발자" },
  ];
  const recent = [
    { sender: "지호", content: "점심 뭐 먹지?" },
    { sender: "하늘", content: "저는 아무거나요" },
  ];

  test("자기 이름과 부른 사람이 들어간다", () => {
    const p = formatOpenChatMessage(self, others, recent, "지호");
    assert.match(p, /단비/);
    assert.match(p, /지호/);
  });

  test("최근 대화가 발신자와 함께 들어간다", () => {
    const p = formatOpenChatMessage(self, others, recent, "지호");
    assert.match(p, /지호: 점심 뭐 먹지\?/);
    assert.match(p, /하늘: 저는 아무거나요/);
  });

  test("다른 NPC 를 이름과 역할로 알려준다 — 지명하려면 이름을 알아야 한다", () => {
    const p = formatOpenChatMessage(self, others, recent, "지호");
    assert.match(p, /하늘/);
    assert.match(p, /디자이너/);
    assert.match(p, /바다/);
  });

  test("회의 프롬프트의 흔적이 없다", () => {
    const p = formatOpenChatMessage(self, others, recent, "지호");
    assert.doesNotMatch(p, /회의/, "수다방에 회의라는 말이 들어가면 NPC 가 회의를 연기한다");
    assert.doesNotMatch(p, /주제/, "맵 채팅에는 안건이 없다");
    assert.doesNotMatch(p, /SPEAK|PASS/, "손들기는 회의 전용이다");
  });

  test("지명 형식을 회의와 동일하게 안내한다", () => {
    const p = formatOpenChatMessage(self, others, recent, "지호");
    assert.match(p, /@\[/, "대괄호 형식 안내가 빠지면 NPC 가 @이름 으로 쓰고 파서가 못 읽는다");
    assert.match(p, /TO:/);
  });

  test("최근 대화가 비어도 깨지지 않는다", () => {
    const p = formatOpenChatMessage(self, others, [], "지호");
    assert.ok(p.length > 0);
    assert.match(p, /지호/);
  });
});
