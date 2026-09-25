import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const SRC = path.join(process.cwd(), "src");

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.tsx$/.test(entry) && !/\.test\.tsx$/.test(entry)) yield full;
  }
}

/** Color names Tailwind can put after `bg-`/`text-`: the theme tokens plus the fixed keywords. */
const COLOR_NAMES = new Set([
  ...[
    ...readFileSync(path.join(SRC, "app/globals.css"), "utf8").matchAll(/--color-([a-z-]+):/g),
  ].map((m) => m[1]),
  "white",
  "black",
  "transparent",
]);
const PALETTE = /^[a-z]+-(50|[1-9]00|950)$/;
const isColor = (name: string) => COLOR_NAMES.has(name) || PALETTE.test(name);

/** Unprefixed color utilities of one kind in a class string (`hover:` etc. are separate states). */
function colors(classes: string, kind: "bg" | "text"): string[] {
  const out = new Set<string>();
  for (const token of classes.split(/\s+/)) {
    if (!token.startsWith(`${kind}-`) || token.includes(":")) continue;
    const name = token.slice(kind.length + 1).replace(/\/\d+$/, "");
    if (isColor(name)) out.add(name);
  }
  return [...out];
}

/** Splits `${…}` holes out of a template body, matching braces. */
function templateParts(body: string): { text: string[]; holes: string[] } {
  const text: string[] = [];
  const holes: string[] = [];
  let i = 0;
  let start = 0;
  while ((i = body.indexOf("${", start)) !== -1) {
    text.push(body.slice(start, i));
    let depth = 1;
    let j = i + 2;
    while (j < body.length && depth > 0) {
      if (body[j] === "{") depth++;
      else if (body[j] === "}") depth--;
      j++;
    }
    holes.push(body.slice(i + 2, j - 1).trim());
    start = j;
  }
  text.push(body.slice(start));
  return { text, holes };
}

/**
 * Every class string a `className` can end up as: string literals, and template literals with
 * same-file `const X = "…"` / `const X = \`…\`` inlined and each `cond ? "a" : "b"` expanded into
 * both branches. That is how the cron panel's `${iconBtn} bg-primary` hid a conflict.
 */
function classStrings(source: string): string[] {
  const consts = new Map<string, string>();
  for (const m of source.matchAll(/const (\w+) =\s*(?:"([^"\n]*)"|`([^`]*)`)/g))
    consts.set(m[1], m[2] ?? m[3]);
  const expand = (body: string, seen: Set<string>): string[] => {
    const { text, holes } = templateParts(body);
    let results = [text[0]];
    holes.forEach((hole, k) => {
      let options = [""];
      const ternary = /\?\s*"([^"]*)"\s*:\s*"([^"]*)"\s*$/.exec(hole);
      if (consts.has(hole) && !seen.has(hole))
        options = expand(consts.get(hole)!, new Set([...seen, hole]));
      else if (ternary) options = [ternary[1], ternary[2]];
      results = results.flatMap((r) => options.map((o) => `${r}${o}${text[k + 1]}`)).slice(0, 64);
    });
    return results;
  };
  const out: string[] = [];
  for (const m of source.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
    if (m[1] !== undefined) out.push(m[1]);
    else out.push(...expand(m[2], new Set()));
  }
  for (const m of source.matchAll(/className=\{(\w+)\}/g))
    if (consts.has(m[1])) out.push(...expand(consts.get(m[1])!, new Set([m[1]])));
  return out;
}

test("no element gets two background colors or two text colors at once", () => {
  // Which one wins depends on CSS order, not class order — the cron panel's primary button
  // rendered bg-surface, white text on white (2026-09-26 staging).
  const offenders: string[] = [];
  for (const file of walk(SRC)) {
    for (const classes of classStrings(readFileSync(file, "utf8"))) {
      for (const kind of ["bg", "text"] as const) {
        const found = colors(classes, kind);
        if (found.length > 1)
          offenders.push(`${path.relative(SRC, file)}: ${kind}-${found.join(` ${kind}-`)}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `한 요소에 같은 종류의 색이 둘이다 — 하나만 남겨라:\n${offenders.join("\n")}`,
  );
});

/**
 * White text needs its own dark background on the same element, or a known dark parent.
 * The app's surfaces are cream, so a bare `text-white` is invisible (the channel settings title).
 */
const WHITE_TEXT_ON_DARK_PARENT = new Set([
  // The close button of the image zoom overlay sits on bg-black/80.
  "components/artifacts/ArtifactList.tsx",
  // The spawn banner's icon sits inside the bg-primary banner.
  "app/game/GamePageClient.tsx",
  // The login button gets its background from an inline style (var(--color-primary)).
  "app/auth/AuthPageClient.tsx",
]);

test("white text always comes with its own background", () => {
  const offenders: string[] = [];
  for (const file of walk(SRC)) {
    const rel = path.relative(SRC, file);
    if (WHITE_TEXT_ON_DARK_PARENT.has(rel)) continue;
    for (const classes of classStrings(readFileSync(file, "utf8"))) {
      if (colors(classes, "text").includes("white") && colors(classes, "bg").length === 0)
        offenders.push(`${rel}: ${classes.trim()}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `배경 없는 text-white 는 크림 표면에서 보이지 않는다:\n${offenders.join("\n")}`,
  );
});
