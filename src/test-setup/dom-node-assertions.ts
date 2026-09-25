/**
 * Finds assertions that compare a DOM node as a value — `assert.equal(host.querySelector("x"), null)`.
 *
 * When such an assertion fails, `node:assert` formats the actual value with `customInspect: false`
 * and a depth of 1000. A rendered node drags its document, window and React fiber graph along, and
 * walking that never finishes: the file hangs until the runner kills it instead of reporting which
 * assertion failed. Assert on a boolean instead (`assert.ok(!host.querySelector("x"))`).
 *
 * The check is syntactic: the first argument must read like a DOM lookup and the second must be
 * `null` or `undefined`. It is a guard against the common shape, not a type check.
 */

const COMPARISONS = ["equal", "strictEqual", "deepEqual", "deepStrictEqual"] as const;

/** Looks like it yields an element (or nothing). */
const DOM_LOOKUP =
  /querySelector|getElementById|getElementsBy|\.closest\(|\bfirstChild\b|\bfirstElementChild\b|\blastElementChild\b|\bparentElement\b|\bnextElementSibling\b|\bpreviousElementSibling\b|\bqueryText\(|\bqueryBy[A-Z]|\$\(/;

export type DomNodeAssertion = {
  /** 0-based offset of `assert.` */
  start: number;
  /** Offset just past the closing `)` of the call. */
  end: number;
  method: (typeof COMPARISONS)[number];
  subject: string;
  expected: "null" | "undefined";
  /** Source of the message argument, if any. */
  message: string | null;
  line: number;
};

/** Splits the call's arguments at top-level commas; returns the end offset past `)`. */
function readArguments(source: string, open: number): { args: string[]; end: number } | null {
  const args: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";
  for (let i = open + 1; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      current += ch;
      if (ch === "\\") {
        current += source[i + 1] ?? "";
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0 && ch === ")") {
        if (current.trim()) args.push(current.trim());
        return { args, end: i + 1 };
      }
      depth -= 1;
    }
    if (ch === "," && depth === 0) {
      args.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  return null;
}

export function findDomNodeAssertions(source: string): DomNodeAssertion[] {
  const found: DomNodeAssertion[] = [];
  const call = new RegExp(`\\bassert\\.(${COMPARISONS.join("|")})\\(`, "g");
  for (const match of source.matchAll(call)) {
    const start = match.index ?? 0;
    const open = start + match[0].length - 1;
    const parsed = readArguments(source, open);
    if (!parsed || parsed.args.length < 2) continue;
    const [subject, expected, message] = parsed.args;
    if (expected !== "null" && expected !== "undefined") continue;
    if (!DOM_LOOKUP.test(subject)) continue;
    found.push({
      start,
      end: parsed.end,
      method: match[1] as DomNodeAssertion["method"],
      subject,
      expected,
      message: message ?? null,
      line: source.slice(0, start).split("\n").length,
    });
  }
  return found;
}

/** The boolean form of one finding: `assert.ok(!<subject>[, message])`. */
export function booleanForm(found: DomNodeAssertion): string {
  const simple = /^[\w$.?]+(\([^()]*\))?(\.[\w$]+)*$/.test(found.subject);
  const negated = simple ? `!${found.subject}` : `!(${found.subject})`;
  return `assert.ok(${negated}${found.message ? `, ${found.message}` : ""})`;
}
