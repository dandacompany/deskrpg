// Body text tokens keep WCAG AA (4.5:1) on the three surfaces of web screens (bg, surface, surface-raised).
// Changing a token value changes the contrast of dozens of screens using that token at once — block it at the value.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const css = ["src/styles/tokens.css", "src/styles/theme-web.css"]
  .map((path) => readFileSync(path, "utf8"))
  .join("\n");

function token(name: string): string {
  const match = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
  assert.ok(match, `--${name} 을 6자리 hex 로 찾지 못했다`);
  return match[1];
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const linear = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test("text tokens are 4.5:1 or more on web screen surfaces", () => {
  for (const text of ["text", "text-secondary", "text-muted"])
    for (const surface of ["bg", "surface", "surface-raised"]) {
      const ratio = contrast(token(text), token(surface));
      assert.ok(ratio >= 4.5, `--${text} on --${surface}: ${ratio.toFixed(2)}:1`);
    }
});

test("even the lightest text (text-dim) is 4.5:1 or more on reading surfaces (bg, surface)", () => {
  // To exceed 4.5:1 on the sunken surface (surface-raised) it would have to equal text-muted, and the hierarchy would vanish.
  // Text on that surface does not use text-dim — use text-muted or stronger.
  for (const surface of ["bg", "surface"]) {
    const ratio = contrast(token("text-dim"), token(surface));
    assert.ok(ratio >= 4.5, `--text-dim on --${surface}: ${ratio.toFixed(2)}:1`);
  }
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name) ? [path] : [];
  });
}

test("text-dim is not placed on the sunken surface (bg-surface-raised) — only disabled controls are exempt", () => {
  const offenders: string[] = [];
  for (const file of sourceFiles("src"))
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, index) => {
        // hover:bg-surface-raised is not a base surface. Disabled controls are exempt from contrast requirements.
        const onRaised = /(^|[\s"'`])bg-surface-raised/.test(line);
        const disabled = /cursor-not-allowed|disabled:/.test(line);
        if (onRaised && /text-text-dim/.test(line) && !disabled)
          offenders.push(`${file}:${index + 1}`);
      });
  assert.deepEqual(offenders, []);
});
