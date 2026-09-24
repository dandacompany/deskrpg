/**
 * Proves that a translation change touched only comments (and test titles).
 *
 * Usage:
 *   npx tsx scripts/check-comment-only-diff.ts <base-ref> [--head <ref>]   # compare base vs head (default: working tree)
 *   npx tsx scripts/check-comment-only-diff.ts --remaining <path>...          # count Hangul comment lines left
 *
 * TS/JS files are parsed and reprinted without comments; `test`/`it`/`describe`/`suite` titles that are plain
 * string literals are blanked, so translating them is allowed. Any other difference fails.
 * Other text files fall back to stripping full-line comments; anything else is listed for manual review.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const HANGUL = /[가-힣]/;
const TS_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);
const TITLE_CALLEES = new Set(["test", "it", "describe", "suite"]);
const HASH_COMMENT_EXT = new Set([".py", ".sh", ".yml", ".yaml", ".toml"]);

function scriptKind(fileName: string): ts.ScriptKind {
  const ext = path.extname(fileName);
  if (ext === ".tsx") return ts.ScriptKind.TSX;
  if (ext === ".jsx") return ts.ScriptKind.JSX;
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return ts.ScriptKind.JSX;
  return ts.ScriptKind.TS;
}

function parse(text: string, fileName: string): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKind(fileName));
}

function isTitleCall(node: ts.CallExpression): boolean {
  let callee: ts.Expression = node.expression;
  // test.skip / describe.only / t.test / test.each(...)(...) — look at the leftmost names.
  while (true) {
    if (ts.isIdentifier(callee)) return TITLE_CALLEES.has(callee.text);
    if (ts.isPropertyAccessExpression(callee)) {
      if (TITLE_CALLEES.has(callee.name.text)) return true;
      callee = callee.expression;
      continue;
    }
    if (ts.isCallExpression(callee)) {
      callee = callee.expression;
      continue;
    }
    return false;
  }
}

/** A string literal, or string literals joined with `+` (no interpolation, no identifiers). */
function isPlainTitle(node: ts.Expression): boolean {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return true;
  if (ts.isParenthesizedExpression(node)) return isPlainTitle(node.expression);
  return (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
    isPlainTitle(node.left) &&
    isPlainTitle(node.right)
  );
}

/** Blank the literal text of a title; an interpolated title keeps its expressions so they still compare. */
function blankTitle(factory: ts.NodeFactory, title: ts.Expression): ts.Expression {
  if (!ts.isTemplateExpression(title)) return factory.createStringLiteral("");
  return factory.createTemplateExpression(
    factory.createTemplateHead(""),
    title.templateSpans.map((span, index) =>
      factory.createTemplateSpan(
        span.expression,
        index === title.templateSpans.length - 1
          ? factory.createTemplateTail("")
          : factory.createTemplateMiddle(""),
      ),
    ),
  );
}

/**
 * The printer keeps the original line layout of some nodes (e.g. a destructuring prettier wrapped after a longer
 * title), so compare token sequences instead of text: layout and trailing commas are ignored, token text —
 * including string contents — is not.
 */
function tokenize(text: string, fileName: string): string {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    scriptKind(fileName) === ts.ScriptKind.TS
      ? ts.LanguageVariant.Standard
      : ts.LanguageVariant.JSX,
    text,
  );
  const tokens: string[] = [];
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    const token = scanner.getTokenText();
    // A trailing comma (what prettier adds when it wraps) carries no meaning.
    if ((token === "}" || token === "]" || token === ")") && tokens.at(-1) === ",") tokens.pop();
    tokens.push(token);
  }
  return tokens.join("\u0001");
}

/** Reprint without comments, with plain test titles blanked. */
export function normalizeSource(text: string, fileName: string): string {
  const source = parse(text, fileName);
  const blankTitles: ts.TransformerFactory<ts.SourceFile> = (context) => {
    const visit = (node: ts.Node): ts.Node => {
      if (ts.isCallExpression(node) && isTitleCall(node) && node.arguments.length > 0) {
        const [first, ...rest] = node.arguments;
        if (isPlainTitle(first) || ts.isTemplateExpression(first)) {
          const visited = ts.visitEachChild(node, visit, context) as ts.CallExpression;
          return context.factory.updateCallExpression(
            visited,
            visited.expression,
            visited.typeArguments,
            [
              blankTitle(context.factory, visited.arguments[0]),
              ...visited.arguments.slice(1, 1 + rest.length),
            ],
          );
        }
      }
      return ts.visitEachChild(node, visit, context);
    };
    return (file) => ts.visitNode(file, visit) as ts.SourceFile;
  };
  const result = ts.transform(source, [blankTitles]);
  const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
  const printed = printer.printFile(result.transformed[0]);
  result.dispose();
  return tokenize(printed, fileName);
}

function commentRanges(text: string, fileName: string): ts.CommentRange[] {
  const source = parse(text, fileName);
  const seen = new Map<number, ts.CommentRange>();
  const add = (ranges: ts.CommentRange[] | undefined) => ranges?.forEach((r) => seen.set(r.pos, r));
  const walk = (node: ts.Node) => {
    add(ts.getLeadingCommentRanges(text, node.getFullStart()));
    add(ts.getTrailingCommentRanges(text, node.getEnd()));
    for (const child of node.getChildren(source)) walk(child);
  };
  walk(source);
  return [...seen.values()];
}

/** Number of comment lines that still contain Hangul. */
export function hangulCommentLines(text: string, fileName: string): number {
  if (!TS_EXT.has(path.extname(fileName))) {
    return text
      .split("\n")
      .filter((line) => /^\s*(#|--|\/\/|\*|\/\*)/.test(line) && HANGUL.test(line)).length;
  }
  let count = 0;
  for (const range of commentRanges(text, fileName)) {
    count += text
      .slice(range.pos, range.end)
      .split("\n")
      .filter((line) => HANGUL.test(line)).length;
  }
  return count;
}

function stripHashComments(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^\s*#(?!!)/.test(line))
    .join("\n");
}

type Verdict = "PASS" | "FAIL" | "REVIEW";

export function compareFile(
  before: string | null,
  after: string | null,
  fileName: string,
): Verdict {
  if (before === null || after === null) return "FAIL"; // translation never adds or removes files
  const ext = path.extname(fileName);
  if (TS_EXT.has(ext)) {
    try {
      return normalizeSource(before, fileName) === normalizeSource(after, fileName)
        ? "PASS"
        : "FAIL";
    } catch {
      return "REVIEW";
    }
  }
  if (HASH_COMMENT_EXT.has(ext) || path.basename(fileName) === "Dockerfile") {
    return stripHashComments(before) === stripHashComments(after) ? "PASS" : "REVIEW";
  }
  return "REVIEW";
}

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

function show(ref: string, file: string): string | null {
  try {
    return git(["show", `${ref}:${file}`]);
  } catch {
    return null;
  }
}

function main(argv: string[]) {
  if (argv[0] === "--remaining") {
    let total = 0;
    for (const file of argv.slice(1)) {
      const n = hangulCommentLines(readFileSync(file, "utf8"), file);
      if (n) console.log(`${String(n).padStart(6)} ${file}`);
      total += n;
    }
    console.log(`total ${total}`);
    return;
  }
  const base = argv[0];
  if (!base)
    throw new Error(
      "usage: check-comment-only-diff <base-ref> [--head <ref>] | --remaining <path>...",
    );
  const headIndex = argv.indexOf("--head");
  const head = headIndex >= 0 ? argv[headIndex + 1] : null;
  const files = git(head ? ["diff", "--name-only", base, head] : ["diff", "--name-only", base])
    .split("\n")
    .filter(Boolean);
  const counts: Record<Verdict, number> = { PASS: 0, FAIL: 0, REVIEW: 0 };
  for (const file of files) {
    const after = head ? show(head, file) : existsSync(file) ? readFileSync(file, "utf8") : null;
    const verdict = compareFile(show(base, file), after, file);
    counts[verdict] += 1;
    if (verdict !== "PASS") console.log(`${verdict.padEnd(6)} ${file}`);
  }
  console.log(`PASS ${counts.PASS} · REVIEW ${counts.REVIEW} · FAIL ${counts.FAIL}`);
  if (counts.FAIL) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename))
  main(process.argv.slice(2));
