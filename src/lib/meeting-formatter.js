/**
 * Meeting message formatter (CommonJS)
 * Ported from claw-meet/broker/src/message-formatter.ts
 *
 * Every template comes in two variants. The Korean one is the original text, byte-for-byte —
 * the Korean meeting protocol teaches its "📋 [회의 알림:" markers. Every other locale gets the
 * English template. `locale` is the last, optional argument: omitted means Korean (the behavior
 * before locales existed), while null (a request without a language cookie) means English.
 */

/**
 * Same rule as promptLocale() in i18n/prompt-locale.ts, kept local so this CommonJS module
 * doesn't require a TypeScript file.
 * @param {string|null|undefined} locale
 * @returns {boolean}
 */
function isKorean(locale) {
  if (locale === undefined) return true;
  return typeof locale === "string" && locale.toLowerCase().slice(0, 2) === "ko";
}

/**
 * A lightweight polling message — informs the agent of the recent remarks and asks whether
 * it wants to speak
 * @param {string} topic
 * @param {Array<{displayName: string, content: string}>} recentTurns
 * @param {{displayName: string}} agent
 * @param {number} currentTurn
 * @param {number} maxTurns
 * @param {number} remainingTurns
 * @param {string|null} [passPolicy]
 * @param {string|null} [locale]
 * @returns {string}
 */
function formatPollMessage(
  topic,
  recentTurns,
  agent,
  currentTurn,
  maxTurns,
  remainingTurns,
  passPolicy,
  locale,
) {
  const recentSummary = recentTurns
    .map(
      (t) => `[${t.displayName}] ${t.content.slice(0, 150)}${t.content.length > 150 ? "..." : ""}`,
    )
    .join("\n");

  if (!isKorean(locale)) {
    let english = `📋 [Meeting poll: ${topic}]
Turn: ${currentTurn}/${maxTurns} | Your remaining turns: ${remainingTurns}

Recent conversation:
${recentSummary}

---`;
    if (passPolicy) {
      english += `\n[Speaking guideline] ${passPolicy}\n`;
    }
    english += `
If you want to speak → SPEAK: (one-line reason)
To pass → PASS

Answer with exactly one of SPEAK: or PASS on the first line.`;
    return english;
  }

  let message = `📋 [회의 알림: ${topic}]
현재 턴: ${currentTurn}/${maxTurns} | 당신의 남은 발언: ${remainingTurns}

최근 대화:
${recentSummary}

---`;

  if (passPolicy) {
    message += `\n[발언 지침] ${passPolicy}\n`;
  }

  message += `
발언하고 싶으면 → SPEAK: (한줄 이유)
넘기려면 → PASS

반드시 SPEAK: 또는 PASS 중 하나로만 첫 줄에 답해주세요.`;

  return message;
}

/**
 * The full-context speaking message
 * @param {string} topic
 * @param {Array<{displayName: string, role: string}>} participants
 * @param {Array<{displayName: string, content: string}>} turns
 * @param {{displayName: string}} agent
 * @param {number} currentTurn
 * @param {number} maxTurns
 * @param {number} remainingTurns
 * @param {string|null} [locale]
 * @returns {string}
 */
function formatSpeakMessage(
  topic,
  participants,
  turns,
  agent,
  currentTurn,
  maxTurns,
  remainingTurns,
  locale,
) {
  const participantList = participants.map((p) => `${p.displayName}(${p.role})`).join(", ");

  const historyText = turns.map((t) => `[${t.displayName}] ${t.content}`).join("\n\n");

  if (!isKorean(locale)) {
    return `📋 [Meeting: ${topic}]
Participants: ${participantList}
Turn: ${currentTurn}/${maxTurns} | Your remaining turns: ${remainingTurns}

---
${historyText}

---
${agent.displayName}, please share your view.
⚠️ Rules: only the key points for this turn, spoken the way you'd talk to a colleague. Never use bullet (-) or numbered (1. 2. 3.) lists. No bold (**). No headers (##). Just talk.
💬 If you want a specific participant to answer, write "TO: Name" on the first line or call them with "@[Name]" in the text. That person answers next. Use exactly the part of the name before the parentheses in the participant list above (without the role), and don't drop the brackets. Example: if the participant is "Danbi(Lead)", write "TO: Danbi" or "@[Danbi]".`;
  }

  return `📋 [회의: ${topic}]
참석자: ${participantList}
현재 턴: ${currentTurn}/${maxTurns} | 당신의 남은 발언: ${remainingTurns}

---
${historyText}

---
${agent.displayName}님, 의견을 말씀해 주세요.
⚠️ 규칙: 동료한테 말하듯이 구어체로, 이번 턴에 필요한 핵심만. 불릿(-)이나 번호(1. 2. 3.) 목록 절대 금지. 볼드(**) 금지. 헤더(##) 금지. 그냥 말로 해.
💬 특정 참석자에게 답을 듣고 싶으면 첫 줄에 "TO: 이름"을 쓰거나 본문에서 "@[이름]"으로 부르세요. 그 사람이 다음에 답합니다. 이름은 위 참석자 목록의 괄호 앞부분(역할 제외)만 정확히 쓰고, 대괄호를 빼먹지 마세요. 예: 참석자가 "단비(팀장)"이면 "TO: 단비" 또는 "@[단비]"라고 쓰세요.`;
}

/**
 * Generates meeting minutes as markdown
 * @param {string} topic
 * @param {Array<{seq: number, displayName: string, content: string, timestamp: number}>} turns
 * @param {Array<{displayName: string, role: string}>} participants
 * @param {string|null} [locale]
 * @returns {string}
 */
function generateTranscript(topic, turns, participants, locale) {
  const date = new Date().toISOString().split("T")[0];
  if (!isKorean(locale)) {
    const english = [
      `# Meeting minutes: ${topic}`,
      "",
      `- **Date**: ${date}`,
      `- **Participants**: ${participants.map((p) => `${p.displayName}(${p.role})`).join(", ")}`,
      `- **Total turns**: ${turns.length}`,
      "",
      "---",
      "",
      "## Conversation",
      "",
    ];
    for (const turn of turns) {
      const time = new Date(turn.timestamp).toLocaleTimeString(locale || "en");
      english.push(`### [${turn.seq}] ${turn.displayName} (${time})`);
      english.push("");
      english.push(turn.content);
      english.push("");
    }
    return english.join("\n");
  }
  const lines = [
    `# 회의록: ${topic}`,
    "",
    `- **일시**: ${date}`,
    `- **참석자**: ${participants.map((p) => `${p.displayName}(${p.role})`).join(", ")}`,
    `- **총 턴**: ${turns.length}`,
    "",
    "---",
    "",
    "## 대화 기록",
    "",
  ];

  for (const turn of turns) {
    const time = new Date(turn.timestamp).toLocaleTimeString("ko-KR");
    lines.push(`### [${turn.seq}] ${turn.displayName} (${time})`);
    lines.push("");
    lines.push(turn.content);
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Parses the SPEAK/PASS intent from the agent's response
 * @param {string} response
 * @param {string|null} [locale]
 * @returns {{ wantsToSpeak: boolean, reason: string }}
 */
function parseHandRaise(response, locale) {
  if (!response || typeof response !== "string") {
    return { wantsToSpeak: false, reason: "" };
  }

  const firstLine = response.split("\n")[0].trim();

  if (/^SPEAK/i.test(firstLine)) {
    const reason = firstLine.replace(/^SPEAK:?\s*/i, "").trim();
    return {
      wantsToSpeak: true,
      reason: reason || (isKorean(locale) ? "(발언 희망)" : "(wants to speak)"),
    };
  }

  return { wantsToSpeak: false, reason: "" };
}

/**
 * Strips the remaining control prefix from a meeting speech response
 *
 * The TO: line is NOT stripped here — this function's result is passed straight through to
 * conversation-engine.ts's parseMention() (mention.ts:46). Stripping TO: here would make the
 * mention silently disappear. Removing TO: for display is done only on the streaming side
 * (sanitizeStreamingSpokenResponse) and the client side (stream-text.ts's
 * sanitizeClientFinalSpeech) — the server transcript already carries the mention.text that
 * parseMention has already stripped.
 * @param {string} response
 * @returns {string}
 */
function sanitizeSpokenResponse(response) {
  if (typeof response !== "string") return "";
  return response.replace(/^\s*SPEAK\s*:?\s*/i, "");
}

// If the first line is `TO: name`, strip that line entirely (same rule as the mention
// parser — splitToLine in src/lib/conversation/mention.ts). If there's no newline yet
// (the name is still being typed), [^\n]* swallows the rest, producing an empty string —
// which lines up exactly with the streaming policy of "hide the TO: prefix until the first
// line is complete".
// Display-only — not applied to sanitizeSpokenResponse (above).
const TO_LINE_PREFIX = /^\s*TO:\s*[^\n]*\n?/i;

/**
 * While streaming, a candidate prefix fragment (S, SP, SPE... / T, TO, TO:...) is held back,
 * and revealed only once the prefix finishes or turns out to be ordinary text.
 * Since this is for display, the TO: line is also stripped (unrelated to the server
 * transcript/mention parsing).
 * @param {string} response
 * @returns {string}
 */
function sanitizeStreamingSpokenResponse(response) {
  if (typeof response !== "string") return "";

  const trimmedStart = response.replace(/^\s+/, "");
  if (
    /^S(?:P(?:E(?:A(?:K(?::?)?)?)?)?)?$/i.test(trimmedStart) ||
    /^T(?:O(?::?)?)?$/i.test(trimmedStart)
  ) {
    return "";
  }

  return sanitizeSpokenResponse(response).replace(TO_LINE_PREFIX, "");
}

module.exports = {
  formatPollMessage,
  formatSpeakMessage,
  generateTranscript,
  parseHandRaise,
  sanitizeSpokenResponse,
  sanitizeStreamingSpokenResponse,
};
