const test = require("node:test");
const assert = require("node:assert/strict");

const { formatSpeakMessage } = require("./meeting-formatter.js");

test("the speak prompt explains the mention format", () => {
  const prompt = formatSpeakMessage(
    "점심 메뉴",
    [
      { displayName: "단비", role: "팀장" },
      { displayName: "소피", role: "개발자" },
    ],
    [],
    { displayName: "소피" },
    1,
    20,
    5,
  );

  // Both formats need to be in the prompt for the NPC to pick between them.
  assert.match(prompt, /TO:/, "TO: 형식이 안내되지 않았습니다");
  assert.match(prompt, /@\[/, "@[이름] 형식이 안내되지 않았습니다");
});
