// Extracts the "who speaks next" mention from a meeting utterance. A pure function — no I/O.
//
// Not parsing free text is the key point. Korean names carry a trailing particle (@단비는,
// @단비님), and a partial match hijacks a similar name (@단비 matching @단비수). So just as
// polling enforces the SPEAK:/PASS format (meeting-formatter.js:113-126), mentions enforce a
// format too.

export type MentionParticipant = { npcId: string; displayName: string };

export type MentionResult = {
  /** The mentioned participant. `null` if none. */
  npcId: string | null;
  /** The utterance body with the TO: line stripped. Identical to the original if there's no mention. */
  text: string;
};

/** If the first line is `TO: name`, returns [name, remaining body]; otherwise `null`. */
function splitToLine(text: string): [string, string] | null {
  const newline = text.indexOf("\n");
  const firstLine = (newline === -1 ? text : text.slice(0, newline)).trim();

  const match = /^TO:\s*(.+)$/i.exec(firstLine);
  if (!match) return null;

  const rest = newline === -1 ? "" : text.slice(newline + 1);
  return [match[1].trim(), rest.trim()];
}

/** Extracts @[name] mentions from the body in order of appearance. */
function bracketMentions(text: string): string[] {
  const names: string[] = [];
  for (const m of text.matchAll(/@\[([^\]]*)\]/g)) {
    names.push(m[1].trim());
  }
  return names;
}

/**
 * Extracts the mention target from an utterance and returns the body to show on screen.
 *
 * If there's a TO: line, it's used and stripped from the body (stripped even if the name
 * isn't a participant — never showing the control prefix to the user takes priority). If
 * there's no TO: line, @[name] mentions in the body are checked in order of appearance and
 * the first one matching a participant is used.
 *
 * Self-mentions are ignored. Without this, one NPC would keep taking the floor back for itself.
 */
export function parseMention(
  text: string,
  participants: MentionParticipant[],
  speakerNpcId: string,
): MentionResult {
  if (typeof text !== "string") return { npcId: null, text: "" };

  const resolve = (name: string): string | null => {
    const hit = participants.find((p) => p.displayName === name);
    if (!hit || hit.npcId === speakerNpcId) return null;
    return hit.npcId;
  };

  const to = splitToLine(text);
  if (to) {
    const [name, body] = to;
    return { npcId: resolve(name), text: body };
  }

  for (const name of bracketMentions(text)) {
    const npcId = resolve(name);
    if (npcId) return { npcId, text };
  }

  return { npcId: null, text };
}

/**
 * Returns **every** mention target in order of appearance. Free chat lets several people
 * respond at once, so unlike parseMention, only one can't be picked.
 *
 * Split from parseMention because: that one means "the single next speaker" and also returns
 * the text with the TO: line stripped from the body. If one function answered two questions
 * with different meanings, the caller would misread the result.
 *
 * If speakerNpcId is null, a human spoke — there's no self to exclude.
 */
/**
 * Returns the mention names contained in an utterance **exactly as written, before
 * resolution**, in order of appearance.
 *
 * `parseAllMentions` keeps only the ones matching a participant, but this one keeps
 * non-participant names too — deciding "did the user try to mention someone" requires
 * counting even typos and non-member mentions (e.g. a mention matching no member at all
 * surfaces a notice instead of total silence).
 */
export function extractMentionNames(text: string): string[] {
  if (typeof text !== "string") return [];
  const to = splitToLine(text);
  if (to) return [to[0], ...bracketMentions(to[1])];
  return bracketMentions(text);
}

export function parseAllMentions(
  text: string,
  participants: MentionParticipant[],
  speakerNpcId: string | null,
): string[] {
  if (typeof text !== "string") return [];

  const names = extractMentionNames(text);

  const out: string[] = [];
  for (const name of names) {
    const hit = participants.find((p) => p.displayName === name);
    if (!hit) continue;
    if (hit.npcId === speakerNpcId) continue;
    if (out.includes(hit.npcId)) continue;
    out.push(hit.npcId);
  }
  return out;
}
