const MAX_PREVIEW_CHARS = 17;

export function buildSpeechBubblePreview(text: string): string {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (normalized.length <= MAX_PREVIEW_CHARS) return normalized;
  return `...${normalized.slice(-MAX_PREVIEW_CHARS)}`;
}
