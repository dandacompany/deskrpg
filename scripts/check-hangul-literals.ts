/**
 * Guards decision 0016: Korean text lives in translation tables, not in code or comments.
 *
 * A Hangul string literal, JSX text or comment is reported unless
 * - the file is on the path allowlist (the Korean locale file, tests, fixtures, source data kept in Korean), or
 * - the literal sits inside a `ko` block — a `ko:`/`...Ko:` property or a `ko`/`...Ko` variable, or
 * - the comment's Hangul appears only inside quotes (quoting exact on-screen Korean text).
 *
 * Usage: npx tsx scripts/check-hangul-literals.ts   # prints offenders, exits 1 if any
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const HANGUL = /[가-힣]/;
const CODE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);

/** Paths that may keep Korean text. Keep this list short and specific. */
const ALLOWED_PATHS: RegExp[] = [
  /^src\/lib\/i18n\/locales\/ko\.ts$/,
  /^src\/lib\/i18n\/context\.tsx$/, // native language name "한국어"
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /^e2e\//,
  /^drizzle\//,
  /^scripts\/readme-capture\//, // Korean README screenshot fixtures
  /^src\/test-setup\//,
  // Source data whose Korean values are the ko variant; other locales come from label maps.
  /^src\/game\/three\/office-looks(-extended)?\.ts$/,
  /^src\/game\/three\/studio-review\.ts$/,
  /^src\/game\/three\/room-labels\.ts$/,
  /^src\/game\/three\/(executive|office|publishing)-room-layout\.ts$/,
  // LLM instruction templates: the ko branch is kept byte-identical inline.
  /^src\/lib\/meeting-formatter\.js$/,
  /^src\/lib\/meeting-outcome\.ts$/,
  /^src\/lib\/meeting-protocol\.ts$/,
];

export type HangulHit = { file: string; line: number; kind: "literal" | "comment"; text: string };

function isKoName(name: string): boolean {
  return name === "ko" || /Ko$/.test(name);
}

function inKoBlock(node: ts.Node): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (
      ts.isPropertyAssignment(parent) &&
      isKoName(parent.name.getText().replace(/^["']|["']$/g, ""))
    )
      return true;
    if (
      ts.isVariableDeclaration(parent) &&
      ts.isIdentifier(parent.name) &&
      isKoName(parent.name.text)
    )
      return true;
  }
  return false;
}

/** Hangul left after removing quoted spans ("…", '…', `…`, “…”, 「…」) and [button labels]. */
function hasUnquotedHangul(comment: string): boolean {
  const unquoted = comment.replace(
    /"[^"\n]*"|'[^'\n]*'|`[^`\n]*`|“[^”\n]*”|「[^」\n]*」|\[[^\]\n]*\]/g,
    "",
  );
  return HANGUL.test(unquoted);
}

function isLiteral(node: ts.Node): boolean {
  return (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isTemplateHead(node) ||
    ts.isTemplateMiddle(node) ||
    ts.isTemplateTail(node) ||
    ts.isJsxText(node)
  );
}

export function findHangul(text: string, file: string): HangulHit[] {
  if (!HANGUL.test(text) || ALLOWED_PATHS.some((pattern) => pattern.test(file))) return [];
  if (!CODE_EXT.has(path.extname(file))) return [];
  const kind = /\.(tsx|jsx|js|cjs|mjs)$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const hits: HangulHit[] = [];
  const seenComments = new Set<number>();
  const lineOf = (pos: number) => source.getLineAndCharacterOfPosition(pos).line + 1;

  const visit = (node: ts.Node) => {
    const ranges = [
      ...(ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []),
      ...(ts.getTrailingCommentRanges(text, node.getEnd()) ?? []),
    ];
    for (const range of ranges) {
      if (seenComments.has(range.pos)) continue;
      seenComments.add(range.pos);
      const body = text.slice(range.pos, range.end);
      body.split("\n").forEach((line, index) => {
        if (hasUnquotedHangul(line)) {
          hits.push({ file, line: lineOf(range.pos) + index, kind: "comment", text: line.trim() });
        }
      });
    }
    if (isLiteral(node) && HANGUL.test(node.getText(source)) && !inKoBlock(node)) {
      hits.push({
        file,
        line: lineOf(node.getStart(source)),
        kind: "literal",
        text: node.getText(source).slice(0, 80),
      });
    }
    for (const child of node.getChildren(source)) visit(child);
  };
  visit(source);
  return hits;
}

export function scanRepository(root = process.cwd()): HangulHit[] {
  const files = execFileSync("git", ["ls-files"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\n")
    .filter((file) => CODE_EXT.has(path.extname(file)));
  return files.flatMap((file) => findHangul(readFileSync(path.join(root, file), "utf8"), file));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  const hits = scanRepository();
  for (const hit of hits) console.log(`${hit.file}:${hit.line} ${hit.kind} ${hit.text}`);
  console.log(`${hits.length} Hangul occurrence(s) outside the allowlist`);
  if (hits.length) process.exitCode = 1;
}
