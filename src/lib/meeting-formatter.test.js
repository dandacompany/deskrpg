const test = require("node:test");
const assert = require("node:assert/strict");

const { formatSpeakMessage } = require("./meeting-formatter.js");

test("발언 프롬프트가 멘션 형식을 알려준다", () => {
  const prompt = formatSpeakMessage(
    "점심 메뉴",
    [{ displayName: "단비", role: "팀장" }, { displayName: "소피", role: "개발자" }],
    [],
    { displayName: "소피" },
    1,
    20,
    5,
  );

  // 두 형식이 모두 프롬프트에 있어야 NPC 가 골라 쓸 수 있다.
  assert.match(prompt, /TO:/, "TO: 형식이 안내되지 않았습니다");
  assert.match(prompt, /@\[/, "@[이름] 형식이 안내되지 않았습니다");
});
