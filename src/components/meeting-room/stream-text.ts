// If the first line is `TO: name`, strip that whole line (same rule as the mention
// parser — splitToLine in src/lib/conversation/mention.ts). If there's no newline yet
// (the name is still being typed), [^\n]* swallows the whole remainder into an empty
// string, which happens to match the streaming policy of "hide the TO: prefix until
// the first line is complete."
const TO_LINE_PREFIX = /^\s*TO:\s*[^\n]*\n?/i;

export function sanitizeClientFinalSpeech(text: string): string {
  if (typeof text !== "string") return "";
  const withoutSpeak = text.replace(/^\s*SPEAK\s*\:?\s*/i, "");
  return withoutSpeak.replace(TO_LINE_PREFIX, "");
}

export function sanitizeClientStreamingSpeech(text: string): string {
  if (typeof text !== "string") return "";

  const trimmedStart = text.replace(/^\s+/, "");
  // If the whole buffer is just a prefix (substring) still growing into "SPEAK:" or
  // "TO:", show nothing yet. Both are control prefixes that aren't complete yet.
  if (
    /^S(?:P(?:E(?:A(?:K(?:\s*:?)?)?)?)?)?\s*$/i.test(trimmedStart) ||
    /^T(?:O(?:\s*:?)?)?\s*$/i.test(trimmedStart)
  ) {
    return "";
  }

  return sanitizeClientFinalSpeech(text);
}
