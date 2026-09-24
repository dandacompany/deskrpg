/**
 * The **wording rules for when an employee reports to the user** (card PVTI_...70a2Y).
 *
 * The screen is already ready to receive it — employee messages render as markdown
 * (`src/components/ui/ChatBubble.tsx:38`) and `![](URL)` draws as `<img>`
 * (`src/components/ui/MarkdownContent.tsx:103-105`). The only thing missing was the
 * instruction to actually output it that way.
 *
 * Follows the same principle as `user-context.ts`: it's a **message prefix**, not a
 * system prompt, and doesn't override a Hermes profile's SOUL. Leaving the rule to each
 * profile's identity would make it vary by employee, so it lives here in one place, and
 * every conversation path (DM, whole office, meeting) uses the same string.
 *
 * Not added to the kanban card path (Dante's decision, 2026-09-20) — that path's
 * injection point is the human-readable card body (`kanban-routes.ts:208`), and a rule
 * paragraph would clutter the screen there.
 */

export const REPORT_FORMAT_HEADER = "[보고 형식]";

/** Keep entries as single lines only — a long prefix pushes the real script back. */
const RULES: readonly string[] = [
  "이미지는 브라우저가 열 수 있는 URL 로 ![설명](URL) 마크다운으로 넣는다. 서버 파일 경로만 적지 않는다.",
  "이미지 URL 이 없으면 결과물로 저장한 뒤 그 링크를 쓴다. 만들지 못했으면 만들었다고 말하지 않는다.",
  "참고한 사이트는 문장 안에 묻지 말고 한 줄에 URL 하나씩 적는다.",
  "표·코드·목록은 마크다운 문법을 쓴다.",
];

export function formatReportFormat(): string {
  return [REPORT_FORMAT_HEADER, ...RULES.map((r) => `- ${r}`)].join("\n");
}

/**
 * Prefixes the rule onto the script. An empty script is returned as-is — this prevents
 * sending only the rule when there's nothing to say.
 */
export function prefixReportFormat(prompt: string): string {
  if (!prompt) return prompt;
  return `${formatReportFormat()}\n\n${prompt}`;
}
