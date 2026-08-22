import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { parseMention, parseAllMentions, MentionParticipant } from "./mention";

const P = [
  { npcId: "n-danbi", displayName: "단비" },
  { npcId: "n-sophie", displayName: "소피" },
  { npcId: "n-danbisu", displayName: "단비수" },
];
const SPEAKER = "n-sophie";

describe("parseMention — TO: 라인", () => {
  test("첫 줄의 TO: 로 지목하고 그 줄을 본문에서 뺀다", () => {
    assert.deepEqual(parseMention("TO: 단비\n어때요?", P, SPEAKER), {
      npcId: "n-danbi",
      text: "어때요?",
    });
  });

  test("콜론 뒤 공백이 없어도 인정한다", () => {
    assert.deepEqual(parseMention("TO:단비\n어때요?", P, SPEAKER), {
      npcId: "n-danbi",
      text: "어때요?",
    });
  });

  test("TO: 가 @[] 보다 우선한다", () => {
    assert.deepEqual(parseMention("TO: 단비\n@[소피] 도 들어주세요", P, SPEAKER), {
      npcId: "n-danbi",
      text: "@[소피] 도 들어주세요",
    });
  });

  test("이름이 참가자에 없어도 TO: 줄은 본문에서 뺀다", () => {
    // 사용자에게 제어 프리픽스를 보이지 않는 것이 우선이다.
    assert.deepEqual(parseMention("TO: 없는사람\n어때요?", P, SPEAKER), {
      npcId: null,
      text: "어때요?",
    });
  });

  test("자기 자신 지목은 무시하되 줄은 뺀다", () => {
    assert.deepEqual(parseMention("TO: 소피\n제 생각은", P, SPEAKER), {
      npcId: null,
      text: "제 생각은",
    });
  });
});

describe("parseMention — 본문 @[이름]", () => {
  test("대괄호 멘션을 인정하고 본문은 그대로 둔다", () => {
    assert.deepEqual(parseMention("@[단비] 생각은?", P, SPEAKER), {
      npcId: "n-danbi",
      text: "@[단비] 생각은?",
    });
  });

  test("조사가 붙어도 안전하다", () => {
    assert.deepEqual(parseMention("@[단비]는 어때요?", P, SPEAKER), {
      npcId: "n-danbi",
      text: "@[단비]는 어때요?",
    });
  });

  test("비슷한 이름을 가로채지 않는다", () => {
    assert.deepEqual(parseMention("@[단비수] 어때요?", P, SPEAKER), {
      npcId: "n-danbisu",
      text: "@[단비수] 어때요?",
    });
  });

  test("여럿이면 첫 번째만 쓴다", () => {
    assert.deepEqual(parseMention("@[단비] 와 @[단비수]", P, SPEAKER), {
      npcId: "n-danbi",
      text: "@[단비] 와 @[단비수]",
    });
  });

  test("첫 번째가 참가자가 아니면 그 다음을 본다", () => {
    assert.deepEqual(parseMention("@[없는사람] 말고 @[단비]", P, SPEAKER), {
      npcId: "n-danbi",
      text: "@[없는사람] 말고 @[단비]",
    });
  });

  test("이름 앞뒤 공백을 허용한다", () => {
    assert.deepEqual(parseMention("@[ 단비 ] 어때요?", P, SPEAKER), {
      npcId: "n-danbi",
      text: "@[ 단비 ] 어때요?",
    });
  });
});

describe("parseMention — 멘션이 아닌 것", () => {
  test("대괄호 없는 @이름 은 멘션이 아니다", () => {
    // 조사 문제를 피하기 위한 의도적 결정이다.
    assert.deepEqual(parseMention("@단비 어때요?", P, SPEAKER), {
      npcId: null,
      text: "@단비 어때요?",
    });
  });

  test("평범한 발언은 그대로 통과한다", () => {
    assert.deepEqual(parseMention("김치찌개가 좋겠습니다.", P, SPEAKER), {
      npcId: null,
      text: "김치찌개가 좋겠습니다.",
    });
  });

  test("본문 중간의 TO: 는 제어 라인이 아니다", () => {
    assert.deepEqual(parseMention("좋아요.\nTO: 단비", P, SPEAKER), {
      npcId: null,
      text: "좋아요.\nTO: 단비",
    });
  });

  test("빈 문자열", () => {
    assert.deepEqual(parseMention("", P, SPEAKER), { npcId: null, text: "" });
  });

  test("참가자 목록이 비어도 죽지 않는다", () => {
    assert.deepEqual(parseMention("@[단비] 어때요?", [], SPEAKER), {
      npcId: null,
      text: "@[단비] 어때요?",
    });
  });
});

describe("parseAllMentions — 지명 전부를 등장 순서대로", () => {
  const people: MentionParticipant[] = [
    { npcId: "n1", displayName: "단비" },
    { npcId: "n2", displayName: "하늘" },
    { npcId: "n3", displayName: "단비수" },
  ];

  test("여러 지명을 등장 순서대로 돌려준다", () => {
    assert.deepEqual(parseAllMentions("@[하늘] @[단비] 어때?", people, null), ["n2", "n1"]);
  });

  test("같은 이름이 두 번 나오면 한 번만 돌려준다", () => {
    assert.deepEqual(parseAllMentions("@[단비] 그리고 @[단비] 또", people, null), ["n1"]);
  });

  test("자기 자신 지명은 뺀다", () => {
    assert.deepEqual(parseAllMentions("@[단비] @[하늘]", people, "n1"), ["n2"]);
  });

  test("사람이 말할 때(null)는 아무도 빠지지 않는다", () => {
    assert.deepEqual(parseAllMentions("@[단비] @[하늘]", people, null), ["n1", "n2"]);
  });

  test("대괄호 없는 @이름 은 지명이 아니다", () => {
    // 한국어 조사(@단비는)와 접두 일치(@단비 가 @단비수 를 삼킴) 때문에 형식을 강제한다.
    assert.deepEqual(parseAllMentions("@단비 어때?", people, null), []);
    assert.deepEqual(parseAllMentions("@단비는 어때?", people, null), []);
  });

  test("접두가 겹치는 이름을 삼키지 않는다", () => {
    assert.deepEqual(parseAllMentions("@[단비수] 안녕", people, null), ["n3"]);
  });

  test("TO: 첫 줄도 지명으로 읽는다", () => {
    assert.deepEqual(parseAllMentions("TO: 하늘\n의견 부탁해요", people, null), ["n2"]);
  });

  test("TO: 와 본문 @[..] 가 함께 있으면 둘 다 센다", () => {
    // TO: 는 "다음 발언자", @[..] 는 본문 속 호명 — 자유채팅에서는 둘 다 깨운다.
    assert.deepEqual(parseAllMentions("TO: 하늘\n@[단비] 너도", people, null), ["n2", "n1"]);
  });

  test("참가자에 없는 이름은 무시한다", () => {
    assert.deepEqual(parseAllMentions("@[없는사람] @[단비]", people, null), ["n1"]);
  });

  test("문자열이 아니면 빈 배열", () => {
    assert.deepEqual(parseAllMentions(null as unknown as string, people, null), []);
  });
});
