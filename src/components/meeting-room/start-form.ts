const MIN_TOPIC_ROWS = 2;
const MAX_TOPIC_ROWS = 5;
const TOPIC_CHARS_PER_ROW = 48;

export function computeMeetingTopicRows(topic: string): number {
  const normalized = topic.trim();
  if (!normalized) return MIN_TOPIC_ROWS;

  const explicitLines = normalized.split("\n");
  const estimatedRows = explicitLines.reduce((sum, line) => {
    const wrappedRows = Math.max(1, Math.ceil(line.length / TOPIC_CHARS_PER_ROW));
    return sum + wrappedRows;
  }, 0);

  return Math.min(MAX_TOPIC_ROWS, Math.max(MIN_TOPIC_ROWS, estimatedRows));
}
