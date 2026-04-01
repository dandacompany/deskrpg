/**
 * 회의 메시지 포맷터 (CommonJS)
 * Ported from claw-meet/broker/src/message-formatter.ts
 */

/**
 * 경량 polling 메시지 — 에이전트에게 최근 발언을 알리고 발언 의사를 묻는다
 * @param {string} topic
 * @param {Array<{displayName: string, content: string}>} recentTurns
 * @param {{displayName: string}} agent
 * @param {number} currentTurn
 * @param {number} maxTurns
 * @param {number} remainingTurns
 * @param {string|null} [passPolicy]
 * @returns {string}
 */
function formatPollMessage(topic, recentTurns, agent, currentTurn, maxTurns, remainingTurns, passPolicy) {
  const recentSummary = recentTurns
    .map((t) => `[${t.displayName}] ${t.content.slice(0, 150)}${t.content.length > 150 ? "..." : ""}`)
    .join("\n");

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
 * 전체 컨텍스트 발언 메시지
 * @param {string} topic
 * @param {Array<{displayName: string, role: string}>} participants
 * @param {Array<{displayName: string, content: string}>} turns
 * @param {{displayName: string}} agent
 * @param {number} currentTurn
 * @param {number} maxTurns
 * @param {number} remainingTurns
 * @returns {string}
 */
function formatSpeakMessage(topic, participants, turns, agent, currentTurn, maxTurns, remainingTurns) {
  const participantList = participants
    .map((p) => `${p.displayName}(${p.role})`)
    .join(", ");

  const historyText = turns
    .map((t) => `[${t.displayName}] ${t.content}`)
    .join("\n\n");

  return `📋 [회의: ${topic}]
참석자: ${participantList}
현재 턴: ${currentTurn}/${maxTurns} | 당신의 남은 발언: ${remainingTurns}

---
${historyText}

---
${agent.displayName}님, 의견을 말씀해 주세요.
⚠️ 규칙: 동료한테 말하듯이 구어체로 3~5문장. 불릿(-)이나 번호(1. 2. 3.) 목록 절대 금지. 볼드(**) 금지. 헤더(##) 금지. 그냥 말로 해.`;
}

/**
 * 회의록을 마크다운으로 생성
 * @param {string} topic
 * @param {Array<{seq: number, displayName: string, content: string, timestamp: number}>} turns
 * @param {Array<{displayName: string, role: string}>} participants
 * @returns {string}
 */
function generateTranscript(topic, turns, participants) {
  const date = new Date().toISOString().split("T")[0];
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
 * 에이전트 응답에서 SPEAK/PASS 의사를 파싱
 * @param {string} response
 * @returns {{ wantsToSpeak: boolean, reason: string }}
 */
function parseHandRaise(response) {
  if (!response || typeof response !== "string") {
    return { wantsToSpeak: false, reason: "" };
  }

  const firstLine = response.split("\n")[0].trim();

  if (/^SPEAK/i.test(firstLine)) {
    const reason = firstLine.replace(/^SPEAK:?\s*/i, "").trim();
    return { wantsToSpeak: true, reason: reason || "(발언 희망)" };
  }

  return { wantsToSpeak: false, reason: "" };
}

/**
 * 회의 발언 응답에서 남아 있는 제어 프리픽스를 제거
 * @param {string} response
 * @returns {string}
 */
function sanitizeSpokenResponse(response) {
  if (typeof response !== "string") return "";
  return response.replace(/^\s*SPEAK\s*:?\s*/i, "");
}

/**
 * 스트리밍 중 prefix 후보 조각(S, SP, SPE...)은 보류하고,
 * prefix가 끝나거나 일반 텍스트로 판명되면 그때부터 노출
 * @param {string} response
 * @returns {string}
 */
function sanitizeStreamingSpokenResponse(response) {
  if (typeof response !== "string") return "";

  const trimmedStart = response.replace(/^\s+/, "");
  if (/^S(?:P(?:E(?:A(?:K(?::?)?)?)?)?)?$/i.test(trimmedStart)) {
    return "";
  }

  return sanitizeSpokenResponse(response);
}

module.exports = {
  formatPollMessage,
  formatSpeakMessage,
  generateTranscript,
  parseHandRaise,
  sanitizeSpokenResponse,
  sanitizeStreamingSpokenResponse,
};
