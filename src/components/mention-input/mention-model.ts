/**
 * The pure model for the mention input. It doesn't know DOM/React, so node:test can attach directly.
 *
 * The content inside the input box is a sequence of text fragments and mention chips. The
 * server (`mention.ts`'s `parseAllMentions`) only understands the `@[name]` string, so a chip
 * only turns into that string at the moment of sending — the wire format is the same as when
 * users used to type `@[Sophie]` by hand.
 */

export type MentionCandidate = { id: string; name: string };

export type Segment =
  { kind: "text"; text: string } | { kind: "mention"; id: string; name: string };

export function serializeSegments(segments: Segment[]): string {
  return segments.map((s) => (s.kind === "text" ? s.text : `@[${s.name}]`)).join("");
}

/**
 * Finds an "open @query" in the text right before the caret. `@` only starts a mention at the
 * beginning of the line or right after whitespace (not an email like `a@b`). A space inside the
 * query is treated as closing it.
 */
export function findMentionQuery(textBeforeCaret: string): { start: number; query: string } | null {
  const at = textBeforeCaret.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && !/\s/.test(textBeforeCaret[at - 1])) return null;
  const query = textBeforeCaret.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { start: at, query };
}

export function filterCandidates(
  query: string,
  candidates: MentionCandidate[],
): MentionCandidate[] {
  const q = query.trim().toLowerCase();
  if (!q) return candidates;
  return candidates.filter((c) => c.name.toLowerCase().includes(q));
}

export type DropdownState = { open: boolean; index: number; count: number; select?: number };

/** Key handling while the dropdown is open. If `select` is present, that index is chosen. */
export function reduceDropdown(state: DropdownState, key: string): DropdownState {
  const { index, count } = state;
  const base = { open: state.open, index, count };
  if (!state.open) return base;
  switch (key) {
    case "ArrowDown":
      return { ...base, index: count === 0 ? 0 : (index + 1) % count };
    case "ArrowUp":
      return { ...base, index: count === 0 ? 0 : (index - 1 + count) % count };
    case "Escape":
      return { ...base, open: false };
    case "Enter":
    case "Tab":
      return count === 0 ? base : { ...base, select: index };
    default:
      return base;
  }
}
