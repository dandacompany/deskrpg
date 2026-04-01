// src/lib/task-parser.js
// NPC 응답에서 태스크 메타데이터를 추출하는 파서.
// 두 가지 모드: block (기본), structured. 동일한 출력 형태 반환.

/* eslint-disable @typescript-eslint/no-require-imports */
const { extractTaskBlocks } = require("./task-block-utils.js");

/**
 * 파서 A: json:task 코드블록 추출
 * @param {string} responseText
 * @returns {{ message: string, tasks: object[] }}
 */
function parseBlockMode(responseText) {
  const { sanitizedText, taskPayloads } = extractTaskBlocks(responseText);
  return { message: sanitizedText, tasks: taskPayloads };
}

/**
 * 파서 B: 구조화 JSON 파싱
 * @param {string} responseText
 * @returns {{ message: string, tasks: object[] }}
 */
function parseStructuredMode(responseText) {
  const parsed = JSON.parse(responseText);
  return {
    message: parsed.message || "",
    tasks: parsed.task ? [parsed.task] : [],
  };
}

/**
 * 통합 파서. 설정에 따라 모드 전환. structured 실패 시 block으로 폴백.
 * @param {string} responseText
 * @param {"block" | "structured"} mode
 * @returns {{ message: string, tasks: object[] }}
 */
function parseNpcResponse(responseText, mode = "block") {
  if (!responseText || typeof responseText !== "string") {
    return { message: responseText || "", tasks: [] };
  }

  if (mode === "structured") {
    try {
      return parseStructuredMode(responseText);
    } catch (e) {
      console.warn("[TaskParser] Structured parse failed, falling back to block mode:", e.message);
      return parseBlockMode(responseText);
    }
  }

  return parseBlockMode(responseText);
}

/**
 * 태스크 액션 유효성 검증
 * @param {unknown} taskAction
 * @returns {boolean}
 */
function isValidTaskAction(taskAction) {
  if (!taskAction || typeof taskAction !== "object") return false;
  const validActions = ["create", "update", "complete", "cancel"];
  const validStatuses = ["pending", "in_progress", "complete", "cancelled"];
  return (
    validActions.includes(taskAction.action) &&
    typeof taskAction.id === "string" &&
    taskAction.id.length > 0 &&
    typeof taskAction.title === "string" &&
    (!taskAction.status || validStatuses.includes(taskAction.status))
  );
}

module.exports = { parseNpcResponse, isValidTaskAction };
