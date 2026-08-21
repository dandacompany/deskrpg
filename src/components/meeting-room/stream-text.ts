// 첫 줄이 `TO: 이름` 이면 그 줄을 통째로 걷어낸다(멘션 파서와 같은 규칙 —
// src/lib/conversation/mention.ts 의 splitToLine). 줄바꿈이 아직 없으면(이름을
// 타이핑 중이면) [^\n]* 가 남은 전체를 삼켜 빈 문자열이 되는데, 이는 스트리밍에서
// "첫 줄이 완성되기 전에는 TO: 접두를 감춘다"는 정책과 그대로 맞아떨어진다.
const TO_LINE_PREFIX = /^\s*TO:\s*[^\n]*\n?/i;

export function sanitizeClientFinalSpeech(text: string): string {
  if (typeof text !== "string") return "";
  const withoutSpeak = text.replace(/^\s*SPEAK\s*\:?\s*/i, "");
  return withoutSpeak.replace(TO_LINE_PREFIX, "");
}

export function sanitizeClientStreamingSpeech(text: string): string {
  if (typeof text !== "string") return "";

  const trimmedStart = text.replace(/^\s+/, "");
  // 버퍼 전체가 "SPEAK:" 또는 "TO:" 로 자라나는 중인 접두(부분 문자열)뿐이면
  // 아직 아무것도 보여주지 않는다. 둘 다 아직 완성되지 않은 제어 프리픽스다.
  if (
    /^S(?:P(?:E(?:A(?:K(?:\s*:?)?)?)?)?)?\s*$/i.test(trimmedStart) ||
    /^T(?:O(?:\s*:?)?)?\s*$/i.test(trimmedStart)
  ) {
    return "";
  }

  return sanitizeClientFinalSpeech(text);
}
