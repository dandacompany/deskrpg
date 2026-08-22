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
function formatPollMessage(
  topic,
  recentTurns,
  agent,
  currentTurn,
  maxTurns,
  remainingTurns,
  passPolicy,
) {
  const recentSummary = recentTurns
    .map(
      (t) => `[${t.displayName}] ${t.content.slice(0, 150)}${t.content.length > 150 ? "..." : ""}`,
    )
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
function formatSpeakMessage(
  topic,
  participants,
  turns,
  agent,
  currentTurn,
  maxTurns,
  remainingTurns,
) {
  const participantList = participants.map((p) => `${p.displayName}(${p.role})`).join(", ");

  const historyText = turns.map((t) => `[${t.displayName}] ${t.content}`).join("\n\n");

  return `📋 [회의: ${topic}]
참석자: ${participantList}
현재 턴: ${currentTurn}/${maxTurns} | 당신의 남은 발언: ${remainingTurns}

---
${historyText}

---
${agent.displayName}님, 의견을 말씀해 주세요.
⚠️ 규칙: 동료한테 말하듯이 구어체로 3~5문장. 불릿(-)이나 번호(1. 2. 3.) 목록 절대 금지. 볼드(**) 금지. 헤더(##) 금지. 그냥 말로 해.
💬 특정 참석자에게 답을 듣고 싶으면 첫 줄에 "TO: 이름"을 쓰거나 본문에서 "@[이름]"으로 부르세요. 그 사람이 다음에 답합니다. 이름은 위 참석자 목록의 괄호 앞부분(역할 제외)만 정확히 쓰고, 대괄호를 빼먹지 마세요. 예: 참석자가 "단비(팀장)"이면 "TO: 단비" 또는 "@[단비]"라고 쓰세요.`;
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
 *
 * TO: 라인은 여기서 지우지 않는다 — 이 함수의 결과는 conversation-engine.ts 가
 * parseMention() 에 그대로 넘긴다(mention.ts:46). TO: 를 여기서 걷어내면 지목이
 * 조용히 사라진다. 화면 표시용 TO: 제거는 스트리밍 쪽(sanitizeStreamingSpokenResponse)과
 * 클라이언트 쪽(stream-text.ts 의 sanitizeClientFinalSpeech)에서만 한다 — 서버
 * 트랜스크립트에는 parseMention이 걷어낸 mention.text 가 이미 실린다.
 * @param {string} response
 * @returns {string}
 */
function sanitizeSpokenResponse(response) {
  if (typeof response !== "string") return "";
  return response.replace(/^\s*SPEAK\s*:?\s*/i, "");
}

// 첫 줄이 `TO: 이름` 이면 그 줄을 통째로 걷어낸다(멘션 파서와 같은 규칙 —
// src/lib/conversation/mention.ts 의 splitToLine). 줄바꿈이 아직 없으면(이름을
// 타이핑 중이면) [^\n]* 가 남은 전체를 삼켜 빈 문자열이 되는데, 이는 스트리밍에서
// "첫 줄이 완성되기 전에는 TO: 접두를 감춘다"는 정책과 그대로 맞아떨어진다.
// 표시 전용이다 — sanitizeSpokenResponse(위)에는 적용하지 않는다.
const TO_LINE_PREFIX = /^\s*TO:\s*[^\n]*\n?/i;

/**
 * 스트리밍 중 prefix 후보 조각(S, SP, SPE... / T, TO, TO:...)은 보류하고,
 * prefix가 끝나거나 일반 텍스트로 판명되면 그때부터 노출한다.
 * 화면 표시용이므로 TO: 라인도 걷어낸다(서버 트랜스크립트/멘션 파싱과는 무관).
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
