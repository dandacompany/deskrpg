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

### Detecting Tasks
- If the player gives a work instruction (research, analysis, report, creation, summarization, etc.), this is a task.
- If the message is casual conversation, a simple question, or small talk, do NOT create a task.
- ${confirmInstruction}

### Task ID Format
- Generate IDs as: {your_name_lowercase}-{YYYYMMDD}-{4_random_hex}
- Example: peter-20260324-a7f3
- Use different random suffix for each new task.

### Responding with Task Metadata
When creating, updating, or completing a task, append a task metadata block at the END of your natural response:

${'```'}json:task
{
  "action": "create",
  "id": "peter-20260324-a7f3",
  "title": "Concise task title (under 50 chars)",
  "status": "in_progress",
  "summary": "1-2 sentence description of current state"
}
${'```'}

### Actions
- **create**: Player approved task registration. Set status to "in_progress".
- **update**: You have progress to report. Keep status "in_progress". Update summary.
- **complete**: You have finished the task and are delivering final results. Set status to "complete".
- **cancel**: Player requested cancellation. Set status to "cancelled".

### Rules
- Maximum ONE task block per response.
- Always write your natural conversational response BEFORE the task block.
- Keep title concise (under 50 chars). Put details in summary.
- When completing a task, deliver the full result in your message text, not in the task block.
- If a player says "취소해", "그만해", "cancel" for an active task, use action "cancel".
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
  const confirmation = translateTaskPrompt(locale, "taskPrompt.confirmRegistration");
  const header = translateTaskPrompt(locale, "taskPrompt.reminderHeader");
  const confirmStep = translateTaskPrompt(locale, "taskPrompt.reminderConfirmStep", {
    confirmation,
  });
  const createStep = translateTaskPrompt(locale, "taskPrompt.reminderCreateStep");
  const requiredFields = translateTaskPrompt(locale, "taskPrompt.reminderRequiredFields");
  const allowedFields = translateTaskPrompt(locale, "taskPrompt.reminderAllowedFields");
  const ignoreCasual = translateTaskPrompt(locale, "taskPrompt.reminderIgnoreCasual");

  return `[SYSTEM REMINDER - MANDATORY TASK PROTOCOL]
${header}
${confirmStep}
${createStep}
${'```'}json:task
{"action":"create","id":"{name}-{YYYYMMDD}-{4hex}","title":"제목","status":"in_progress","summary":"요약"}
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

module.exports = {
  TASK_CORE_PROMPT,
  injectTaskPrompt,
  TASK_REMINDER,
  withTaskReminder,
  buildTaskCorePrompt,
  buildTaskReminder,
  normalizeTaskPromptLocale,
};
