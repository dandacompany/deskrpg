/* eslint-disable @typescript-eslint/no-require-imports */
const test = require("node:test");
const assert = require("node:assert/strict");

const { extractTaskBlocks, sanitizeNpcResponseText } = require("./task-block-utils.js");
const { parseNpcResponse } = require("./task-parser.js");

test("extractTaskBlocks strips complete json:task blocks and returns parsed payload", () => {
  const input = [
    "알겠습니다. 바로 조사하겠습니다.",
    "```json:task",
    '{"action":"create","id":"eunyu-1","title":"뉴스 조사","status":"in_progress","summary":"착수"}',
    "```",
  ].join("\n");

  const result = extractTaskBlocks(input);

  assert.equal(result.sanitizedText, "알겠습니다. 바로 조사하겠습니다.");
  assert.deepEqual(result.taskPayloads, [
    {
      action: "create",
      id: "eunyu-1",
      title: "뉴스 조사",
      status: "in_progress",
      summary: "착수",
    },
  ]);
});

test("sanitizeNpcResponseText hides incomplete trailing json:task blocks during streaming", () => {
  const input = [
    "지금은 공식 문서, 지상파, 커뮤니티 쪽에서 큰 변화부터 잡고 있어요.",
    "```json:task",
    '{"action":"update","id":"eunyu-1"',
  ].join("\n");

  assert.equal(
    sanitizeNpcResponseText(input, { stripIncompleteTail: true }),
    "지금은 공식 문서, 지상파, 커뮤니티 쪽에서 큰 변화부터 잡고 있어요.",
  );
});

test("parseNpcResponse returns clean message without leaking task control block", () => {
  const input = [
    "오늘 흐름을 먼저 훑고 핵심만 정리해드릴게요.",
    "",
    "```json:task",
    '{"action":"update","id":"eunyu-1","title":"뉴스 조사","status":"in_progress","summary":"초기 탐색 완료"}',
    "```",
  ].join("\n");

  const result = parseNpcResponse(input);

  assert.equal(result.message, "오늘 흐름을 먼저 훑고 핵심만 정리해드릴게요.");
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].action, "update");
});
