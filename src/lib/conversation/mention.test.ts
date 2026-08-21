import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { parseMention } from "./mention";

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
