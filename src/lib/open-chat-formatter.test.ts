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

  test("includes the speaker's own name and the name of the person called", () => {
    const p = formatOpenChatMessage(self, others, recent, "지호");
    assert.match(p, /단비/);
    assert.match(p, /지호/);
  });

  test("includes recent messages along with their sender", () => {
    const p = formatOpenChatMessage(self, others, recent, "지호");
    assert.match(p, /지호: 점심 뭐 먹지\?/);
    assert.match(p, /하늘: 저는 아무거나요/);
  });

  test("tells the other NPCs' names and roles — a name is needed to mention someone", () => {
    const p = formatOpenChatMessage(self, others, recent, "지호");
    assert.match(p, /하늘/);
    assert.match(p, /디자이너/);
    assert.match(p, /바다/);
  });

  test("has no trace of the meeting prompt", () => {
    const p = formatOpenChatMessage(self, others, recent, "지호");
    assert.doesNotMatch(p, /회의/, "수다방에 회의라는 말이 들어가면 NPC 가 회의를 연기한다");
    assert.doesNotMatch(p, /주제/, "맵 채팅에는 안건이 없다");
    assert.doesNotMatch(p, /SPEAK|PASS/, "손들기는 회의 전용이다");
  });

  test("explains the mention format the same way as the meeting does", () => {
    const p = formatOpenChatMessage(self, others, recent, "지호");
    assert.match(p, /@\[/, "대괄호 형식 안내가 빠지면 NPC 가 @이름 으로 쓰고 파서가 못 읽는다");
    assert.match(p, /TO:/);
  });

  test("doesn't break even when recent messages are empty", () => {
    const p = formatOpenChatMessage(self, others, [], "지호");
    assert.ok(p.length > 0);
    assert.match(p, /지호/);
  });
});

test('passing the caller\'s context inserts one "[대화 상대]" line right after the first line', () => {
  const without = formatOpenChatMessage({ displayName: "단비" }, [], [], "곽지호");
  const withCaller = formatOpenChatMessage({ displayName: "단비" }, [], [], "곽지호", {
    name: "곽지호",
    bio: "단테랩스 대표",
  });
  const [first, ...rest] = without.split("\n");
  assert.equal(
    withCaller,
    [first, "[대화 상대] 이름: 곽지호 · 소개: 단테랩스 대표", ...rest].join("\n"),
  );
  assert.equal(formatOpenChatMessage({ displayName: "단비" }, [], [], "곽지호", null), without);
});

test("the report-format rule is also included in the office all-hands chat script", () => {
  const p = formatOpenChatMessage({ displayName: "단비" }, [], [], "곽지호");
  assert.match(p, /\[보고 형식\]/);
  assert.match(p, /!\[설명\]\(URL\)/);
  assert.match(p, /한 줄에 URL 하나/);
});
