export function sanitizeClientFinalSpeech(text: string): string {
  if (typeof text !== "string") return "";
  return text.replace(/^\s*SPEAK\s*\:?\s*/i, "");
}

export function sanitizeClientStreamingSpeech(text: string): string {
  if (typeof text !== "string") return "";

  const trimmedStart = text.replace(/^\s+/, "");
  if (/^S(?:P(?:E(?:A(?:K(?:\s*:?)?)?)?)?)?\s*$/i.test(trimmedStart)) {
    return "";
  }

  return sanitizeClientFinalSpeech(text);
}
