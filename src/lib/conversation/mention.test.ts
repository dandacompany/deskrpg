import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  parseMention,
  parseAllMentions,
  extractMentionNames,
  formatMention,
  MentionParticipant,
} from "./mention";

const P = [
  { npcId: "n-danbi", displayName: "단비" },
  { npcId: "n-sophie", displayName: "소피" },
  { npcId: "n-danbisu", displayName: "단비수" },
];
const SPEAKER = "n-sophie";

describe("parseMention — TO: line", () => {
  test("names via a first-line TO: and strips that line from the body", () => {
    assert.deepEqual(parseMention("TO: 단비\n어때요?", P, SPEAKER), {
      npcId: "n-danbi",
      text: "어때요?",
    });
  });

  test("accepts it even with no space after the colon", () => {
    assert.deepEqual(parseMention("TO:단비\n어때요?", P, SPEAKER), {
      npcId: "n-danbi",
      text: "어때요?",
    });
  });

  test("TO: takes priority over @[]", () => {
    assert.deepEqual(parseMention("TO: 단비\n@[소피] 도 들어주세요", P, SPEAKER), {
      npcId: "n-danbi",
      text: "@[소피] 도 들어주세요",
    });
  });

  test("strips the TO: line from the body even when the name isn't a participant", () => {
    // Keeping the control prefix hidden from the user takes priority.
    assert.deepEqual(parseMention("TO: 없는사람\n어때요?", P, SPEAKER), {
      npcId: null,
      text: "어때요?",
    });
  });

  test("ignores a self-mention but still strips the line", () => {
    assert.deepEqual(parseMention("TO: 소피\n제 생각은", P, SPEAKER), {
      npcId: null,
      text: "제 생각은",
    });
  });
});

describe("parseMention — in-body @[name]", () => {
  test("recognizes a bracketed mention and leaves the body as-is", () => {
    assert.deepEqual(parseMention("@[단비] 생각은?", P, SPEAKER), {
      npcId: "n-danbi",
      text: "@[단비] 생각은?",
    });
  });

  test("is safe even with a trailing particle attached", () => {
    assert.deepEqual(parseMention("@[단비]는 어때요?", P, SPEAKER), {
      npcId: "n-danbi",
      text: "@[단비]는 어때요?",
    });
  });

  test("doesn't get captured by a similar name", () => {
    assert.deepEqual(parseMention("@[단비수] 어때요?", P, SPEAKER), {
      npcId: "n-danbisu",
      text: "@[단비수] 어때요?",
    });
  });

  test("uses only the first one when there are several", () => {
    assert.deepEqual(parseMention("@[단비] 와 @[단비수]", P, SPEAKER), {
      npcId: "n-danbi",
      text: "@[단비] 와 @[단비수]",
    });
  });

  test("looks at the next one if the first isn't a participant", () => {
    assert.deepEqual(parseMention("@[없는사람] 말고 @[단비]", P, SPEAKER), {
      npcId: "n-danbi",
      text: "@[없는사람] 말고 @[단비]",
    });
  });

  test("allows whitespace around the name", () => {
    assert.deepEqual(parseMention("@[ 단비 ] 어때요?", P, SPEAKER), {
      npcId: "n-danbi",
      text: "@[ 단비 ] 어때요?",
    });
  });
});

describe("parseMention — not a mention", () => {
  test("@name without brackets is not a mention", () => {
    // An intentional decision to avoid issues with Korean particles.
    assert.deepEqual(parseMention("@단비 어때요?", P, SPEAKER), {
      npcId: null,
      text: "@단비 어때요?",
    });
  });

  test("an ordinary remark passes through unchanged", () => {
    assert.deepEqual(parseMention("김치찌개가 좋겠습니다.", P, SPEAKER), {
      npcId: null,
      text: "김치찌개가 좋겠습니다.",
    });
  });

  test("a TO: in the middle of the body is not a control line", () => {
    assert.deepEqual(parseMention("좋아요.\nTO: 단비", P, SPEAKER), {
      npcId: null,
      text: "좋아요.\nTO: 단비",
    });
  });

  test("empty string", () => {
    assert.deepEqual(parseMention("", P, SPEAKER), { npcId: null, text: "" });
  });

  test("doesn't crash on an empty participant list", () => {
    assert.deepEqual(parseMention("@[단비] 어때요?", [], SPEAKER), {
      npcId: null,
      text: "@[단비] 어때요?",
    });
  });
});

describe("parseAllMentions — all mentions in appearance order", () => {
  const people: MentionParticipant[] = [
    { npcId: "n1", displayName: "단비" },
    { npcId: "n2", displayName: "하늘" },
    { npcId: "n3", displayName: "단비수" },
  ];

  test("returns multiple mentions in appearance order", () => {
    assert.deepEqual(parseAllMentions("@[하늘] @[단비] 어때?", people, null), ["n2", "n1"]);
  });

  test("returns the same name only once when it appears twice", () => {
    assert.deepEqual(parseAllMentions("@[단비] 그리고 @[단비] 또", people, null), ["n1"]);
  });

  test("excludes a self-mention", () => {
    assert.deepEqual(parseAllMentions("@[단비] @[하늘]", people, "n1"), ["n2"]);
  });

  test("when a human is speaking (null), no one is excluded", () => {
    assert.deepEqual(parseAllMentions("@[단비] @[하늘]", people, null), ["n1", "n2"]);
  });

  test("@name without brackets is not a mention", () => {
    // The format is enforced because of Korean particles (@단비는) and prefix matches
    // (@단비 swallowing @단비수).
    assert.deepEqual(parseAllMentions("@단비 어때?", people, null), []);
    assert.deepEqual(parseAllMentions("@단비는 어때?", people, null), []);
  });

  test("doesn't swallow a name that overlaps as a prefix", () => {
    assert.deepEqual(parseAllMentions("@[단비수] 안녕", people, null), ["n3"]);
  });

  test("also reads a first-line TO: as a mention", () => {
    assert.deepEqual(parseAllMentions("TO: 하늘\n의견 부탁해요", people, null), ["n2"]);
  });

  test("counts both when TO: and an in-body @[..] are both present", () => {
    // TO: means "next speaker", @[..] is a name called out in the body — free chat wakes
    // both up.
    assert.deepEqual(parseAllMentions("TO: 하늘\n@[단비] 너도", people, null), ["n2", "n1"]);
  });

  test("ignores a name that isn't a participant", () => {
    assert.deepEqual(parseAllMentions("@[없는사람] @[단비]", people, null), ["n1"]);
  });

  test("returns an empty array when the input isn't a string", () => {
    assert.deepEqual(parseAllMentions(null as unknown as string, people, null), []);
  });
});

describe("extractMentionNames — raw names before resolution", () => {
  test("counts a name even if it isn't a participant", () => {
    // A typo or non-member mention is still a signal of "intended to mention someone", so
    // it's kept.
    assert.deepEqual(extractMentionNames("@[없는사람] @[단비]"), ["없는사람", "단비"]);
  });

  test("returns an empty array when there's no mention", () => {
    assert.deepEqual(extractMentionNames("그냥 인사"), []);
  });

  test("counts a TO: line as a name too", () => {
    assert.deepEqual(extractMentionNames("TO: 하늘\n@[단비] 너도"), ["하늘", "단비"]);
  });

  test("returns an empty array when the input isn't a string", () => {
    assert.deepEqual(extractMentionNames(null as unknown as string), []);
  });
});

describe("mention delimiters inside names", () => {
  const odd = [
    { npcId: "n-bracket", displayName: "Kim [Ops] ]" },
    { npcId: "n-slash", displayName: "a\\b" },
    { npcId: "n-plain", displayName: "소피" },
  ];

  test("a plain name is written exactly as before", () => {
    assert.equal(formatMention("소피"), "@[소피]");
  });

  test("brackets and backslashes in a name are escaped", () => {
    assert.equal(formatMention("Kim [Ops] ]"), "@[Kim \\[Ops\\] \\]]");
    assert.equal(formatMention("a\\b"), "@[a\\\\b]");
  });

  test("formatted mentions round-trip through the parser, even with delimiters in the name", () => {
    const text = `${formatMention("Kim [Ops] ]")} and ${formatMention("a\\b")} and ${formatMention("소피")} please`;
    assert.deepEqual(extractMentionNames(text), ["Kim [Ops] ]", "a\\b", "소피"]);
    assert.deepEqual(parseAllMentions(text, odd, null), ["n-bracket", "n-slash", "n-plain"]);
    assert.equal(
      parseMention(`${formatMention("Kim [Ops] ]")} hi`, odd, "n-plain").npcId,
      "n-bracket",
    );
  });

  test("hand-typed plain mentions still parse", () => {
    assert.deepEqual(parseAllMentions("@[소피] 안녕", odd, null), ["n-plain"]);
  });
});
