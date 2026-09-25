import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { CHAT_ACCENT, accentClasses } from "./chat-accent";

const SRC = path.join(process.cwd(), "src");

/** Shape of a string-assembled Tailwind palette class: `bg-${x}-500`, `text-${x}-200` … */
const ASSEMBLED =
  /\b(bg|text|border|ring|from|via|to|fill|stroke|shadow|outline|divide|decoration|caret|placeholder)-\$\{[^}]+\}-/;

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.tsx?$/.test(entry)) yield full;
  }
}

test("no place assembles a Tailwind class via string concatenation", () => {
  const offenders: string[] = [];
  for (const file of walk(SRC)) {
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        const bare = line.trim();
        // Comments quote this shape to explain the rule — they aren't a check target.
        if (bare.startsWith("*") || bare.startsWith("//") || bare.startsWith("/*")) return;
        if (ASSEMBLED.test(line)) offenders.push(`${path.relative(SRC, file)}:${i + 1} ${bare}`);
      });
  }
  assert.deepEqual(
    offenders,
    [],
    `조립한 Tailwind 클래스는 빌드 때 생성되지 않아 색이 조용히 사라진다. 미리 정의된 클래스 맵으로 바꿔라:\n${offenders.join("\n")}`,
  );
});

test("accent colors don't use white text or palette names on a cream background", () => {
  // White text on a saturated accent surface (button) is fine. The forbidden case is a slot laid over the cream surface.
  const onSurface = new Set(["option", "chip"]);
  for (const [name, classes] of Object.entries(CHAT_ACCENT)) {
    for (const [slot, value] of Object.entries(classes)) {
      if (onSurface.has(slot)) {
        assert.equal(
          /\btext-white\b/.test(value),
          false,
          `${name}.${slot} 은 크림 surface 위에 얹히는데 text-white 를 쓴다(대비 1.03:1)`,
        );
        assert.ok(/\btext-text\b/.test(value), `${name}.${slot} 글자색이 본문 토큰이 아니다`);
      }
      assert.equal(
        /\b(amber|indigo|slate|gray|zinc)-\d/.test(value),
        false,
        `${name}.${slot} 이 브랜드 토큰이 아닌 팔레트를 쓴다: ${value}`,
      );
    }
  }
});

test("an unknown accent color falls back to the default", () => {
  assert.equal(accentClasses(), CHAT_ACCENT.npc);
  assert.equal(accentClasses("meeting"), CHAT_ACCENT.meeting);
  // Even if a bogus value arrives at runtime, the class must not become undefined.
  assert.equal(accentClasses("nope" as never), CHAT_ACCENT.npc);
});

/**
 * On the cream surface (#fcfcf8), palette text-color shades of 600 or lighter fail AA (4.5:1).
 * Measured: text-amber-300 1.40:1, text-emerald-300 1.48:1, text-red-400 2.69:1,
 * text-amber-600 3.10:1, text-red-500 3.71:1, text-red-600 4.63:1 (borderline).
 * The same goes for a badge with its own pale background — text-amber-700 on bg-amber-500/15 is 4.38:1.
 * Use the semantic-color tokens (text-danger/text-success/text-info/text-npc-dark) instead.
 *
 * 700 and above pass on contrast (4.55-8.77:1) but still break the one-product-color rule
 * (docs/standards.md) and would not follow a theme change, so every shade is blocked.
 */
const PALE_PALETTE_TEXT =
  /\btext-(amber|indigo|emerald|sky|rose|violet|teal|red|blue|green|yellow|slate|gray|zinc|stone|neutral|orange|lime|cyan|fuchsia|pink|purple)-(50|[1-9]00|950)\b/;

test("doesn't use palette text colors — uses semantic-color tokens instead", () => {
  const offenders: string[] = [];
  for (const file of walk(SRC)) {
    if (file.endsWith("chat-accent.test.ts")) continue;
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        const bare = line.trim();
        if (bare.startsWith("*") || bare.startsWith("//") || bare.startsWith("/*")) return;
        if (PALE_PALETTE_TEXT.test(line))
          offenders.push(`${path.relative(SRC, file)}:${i + 1} ${bare}`);
      });
  }
  assert.deepEqual(
    offenders,
    [],
    `크림 배경 위 옅은 팔레트 글자색은 대비가 AA 에 못 미친다. 의미색 토큰으로 바꿔라 — 오류 text-danger, 성공 text-success, 정보 text-info, 경고 text-npc-dark:\n${offenders.join("\n")}`,
  );
});

/**
 * A meaning-bearing color name is used **only when it's defined**. Tailwind silently drops
 * utilities for unknown color names, so `text-warning` passes build, types, and lint while
 * producing no color at all — on 2026-09-21, three spots meant to say "the user must act" were
 * dead exactly this way (warnings use the `npc-dark` token).
 */
const SEMANTIC_COLOR_NAMES = ["warning", "error", "caution", "alert", "positive", "negative"];

test("doesn't use a utility class with an undefined semantic-color name", () => {
  const css = ["styles/tokens.css", "app/globals.css"]
    .map((file) => readFileSync(path.join(SRC, file), "utf8"))
    .join("\n");
  const undefinedNames = SEMANTIC_COLOR_NAMES.filter((name) => !css.includes(`--color-${name}:`));
  const pattern = new RegExp(
    `\\b(text|bg|border|fill|stroke|ring|from|to|via)-(${undefinedNames.join("|")})\\b`,
  );
  const offenders: string[] = [];
  for (const file of walk(SRC)) {
    if (file.endsWith("chat-accent.test.ts")) continue;
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        const bare = line.trim();
        if (bare.startsWith("*") || bare.startsWith("//") || bare.startsWith("/*")) return;
        if (pattern.test(line)) offenders.push(`${path.relative(SRC, file)}:${i + 1} ${bare}`);
      });
  }
  assert.deepEqual(
    offenders,
    [],
    `정의되지 않은 색 이름이라 아무 색도 나지 않는다. 토큰을 정의하거나 있는 토큰을 써라(경고는 text-npc-dark):\n${offenders.join("\n")}`,
  );
});

/**
 * Backgrounds, borders and the other color utilities follow the same rule: a literal palette
 * class ignores the theme tokens (tokens.css), so a theme change or dark mode would have to fix
 * each one by hand. Use a token of the same hue family with opacity instead (`bg-danger/10`,
 * `border-npc/40`, `bg-info`).
 *
 * The allowlist is empty and may only stay that way — a new literal anywhere fails.
 */
const LITERAL_PALETTE =
  /(?<![\w-])(?:[a-z-]+:)*(?:bg|border|ring|from|via|to|fill|stroke|shadow|outline|divide|decoration|caret|placeholder)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|[1-9]00|950)(?:\/\d+)?(?![\w-])/g;
const PALETTE_ALLOWED: Record<string, string[]> = {};

test("doesn't use palette background, border or other color utilities outside the allowlist", () => {
  const found: Record<string, string[]> = {};
  for (const file of walk(SRC)) {
    if (file.endsWith("chat-accent.test.ts")) continue;
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line) => {
        const bare = line.trim();
        if (bare.startsWith("*") || bare.startsWith("//") || bare.startsWith("/*")) return;
        for (const match of line.matchAll(LITERAL_PALETTE))
          (found[path.relative(SRC, file)] ??= []).push(match[0]);
      });
  }
  const offenders: string[] = [];
  for (const [file, classes] of Object.entries(found)) {
    const allowed = [...(PALETTE_ALLOWED[file] ?? [])];
    for (const cls of classes) {
      const i = allowed.indexOf(cls);
      if (i === -1) offenders.push(`${file} ${cls}`);
      else allowed.splice(i, 1);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `리터럴 팔레트 대신 같은 색 계열 토큰과 불투명도를 써라(bg-danger/10, border-npc/40, bg-info):\n${offenders.join("\n")}`,
  );
});
