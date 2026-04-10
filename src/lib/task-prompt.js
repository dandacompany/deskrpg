// src/lib/task-prompt.js
// NPC identity에 멱등하게 주입되는 태스크 프로토콜 지시문.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { taskPromptMessages } = require("./i18n/task-prompt-messages.js");

function normalizeTaskPromptLocale(locale) {
  const base = typeof locale === "string" ? locale.toLowerCase().slice(0, 2) : "";
  if (base === "ko" || base === "ja" || base === "zh") return base;
  return "en";
}

function translateTaskPrompt(locale, key, params) {
  const normalizedLocale = normalizeTaskPromptLocale(locale);
  let text = taskPromptMessages[normalizedLocale]?.[key]
    ?? taskPromptMessages.en[key]
    ?? key;

  if (params) {
    for (const [paramKey, value] of Object.entries(params)) {
      text = text.replace(new RegExp(`\\{${paramKey}\\}`, "g"), String(value));
    }
  }

  return text;
}

function buildTaskCorePrompt(locale) {
  const confirmation = translateTaskPrompt(locale, "taskPrompt.confirmRegistration");
  const confirmInstruction = translateTaskPrompt(locale, "taskPrompt.coreConfirmInstruction", {
    confirmation,
  });

  return `
## Task Management Protocol

You have task management capabilities. Follow this protocol when interacting with players.

### How Tasks Work
- Tasks are registered by the player or the system. You do NOT create tasks yourself.
- When the system tells you a task has been pre-registered with a specific ID, work on it immediately.
- If the player asks you to do something but it is NOT registered as a task, just respond normally without a task block.

### Responding with Task Metadata
When working on a registered task, append a task metadata block at the END of your natural response:

${'```'}json:task
{
  "action": "update",
  "id": "task-20260410-a7f3",
  "title": "Concise task title (under 50 chars)",
  "status": "in_progress",
  "summary": "1-2 sentence description of current state"
}
${'```'}

### Actions
- **update**: You have progress to report on a registered task. Keep status "in_progress". Update summary.
- **complete**: You have finished the task and are delivering final results. Set status to "complete".
- **cancel**: Player requested cancellation. Set status to "cancelled".

### Rules
- Maximum ONE task block per response.
- Always write your natural conversational response BEFORE the task block.
- Keep title concise (under 50 chars). Put details in summary.
- The "id" field must exactly match the task ID provided by the system.
- When completing a task, deliver the full result in your message text, not in the task block.
- If a player says "취소해", "그만해", "cancel" for an active task, use action "cancel".
- Do NOT emit a task block for casual conversation or simple questions.
`.trim();
}

const TASK_CORE_PROMPT = buildTaskCorePrompt("en");

/**
 * identity에 태스크 프로토콜을 prepend. 이미 포함되어 있으면 건너뜀 (멱등성).
 * @param {string} userIdentity
 * @param {string | null | undefined} locale
 * @returns {string}
 */
function injectTaskPrompt(userIdentity, locale) {
  if (userIdentity && userIdentity.includes("Task Management Protocol")) {
    return userIdentity;
  }
  return buildTaskCorePrompt(locale) + "\n\n" + (userIdentity || "");
}

/**
 * 대화 히스토리가 길어질 때 LLM에게 프로토콜을 상기시키는 짧은 리마인더.
 * 사용자 메시지 앞에 [SYSTEM] 태그로 prepend된다.
 */
function buildTaskReminder(locale) {
  const requiredFields = translateTaskPrompt(locale, "taskPrompt.reminderRequiredFields");
  const allowedFields = translateTaskPrompt(locale, "taskPrompt.reminderAllowedFields");
  const ignoreCasual = translateTaskPrompt(locale, "taskPrompt.reminderIgnoreCasual");

  return `[SYSTEM REMINDER - MANDATORY TASK PROTOCOL]
- Tasks are pre-registered by the system. Use the exact task ID provided.
- When completing or updating a task, include a json:task block at the end of your response.
${'```'}json:task
{"action":"update","id":"task-XXXXXXXX-xxxx","title":"제목","status":"in_progress","summary":"요약"}
${'```'}
${requiredFields}
${allowedFields}
${ignoreCasual}`;
}

const TASK_REMINDER = buildTaskReminder("en");

/**
 * 사용자 메시지에 프로토콜 리마인더를 prepend.
 * 매 메시지마다 주입하되, 리마인더가 사용자에게 보이지 않으므로 부담 없음.
 * @param {string} userMessage - 원본 사용자 메시지
 * @param {string | null | undefined} locale
 * @returns {string}
 */
function withTaskReminder(userMessage, locale) {
  return buildTaskReminder(locale) + "\n\n" + userMessage;
}

function buildTaskSessionPrompt(task, locale) {
  const context = [
    "[TASK CONTEXT]",
    `현재 태스크: ${task.title}`,
    `태스크 ID: ${task.npcTaskId}`,
    `상태: ${task.status}`,
    `생성일: ${task.createdAt}`,
  ];
  if (task.summary) {
    context.push(`최근 요약: ${task.summary}`);
  }
  context.push("");
  context.push("이 대화는 위 태스크 전용입니다.");
  context.push("태스크와 관련된 작업에 집중하되, 사용자의 추가 지시에 유연하게 대응하세요.");
  context.push("진행 상황 업데이트 시 반드시 json:task 블록을 포함하세요.");

  return context.join("\n") + "\n\n" + buildTaskCorePrompt(locale);
}

module.exports = {
  TASK_CORE_PROMPT,
  injectTaskPrompt,
  TASK_REMINDER,
  withTaskReminder,
  buildTaskCorePrompt,
  buildTaskReminder,
  buildTaskSessionPrompt,
  normalizeTaskPromptLocale,
};
