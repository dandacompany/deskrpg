import assert from "node:assert/strict";
import test from "node:test";

import { hangulCommentLines, normalizeSource } from "./check-comment-only-diff";

test("comment-only edits normalize to the same source", () => {
  const before = `// 한글 주석\nconst a = 1; /* 블록 */\nexport function f() {\n  return a; // 끝\n}\n`;
  const after = `// English comment\nconst a = 1; /* block */\nexport function f() {\n  return a; // end\n}\n`;
  assert.equal(normalizeSource(before, "x.ts"), normalizeSource(after, "x.ts"));
});

test("JSX comments are ignored", () => {
  const before = `export const C = () => <div>{/* 설명 */}<span>hi</span></div>;\n`;
  const after = `export const C = () => <div>{/* note */}<span>hi</span></div>;\n`;
  assert.equal(normalizeSource(before, "x.tsx"), normalizeSource(after, "x.tsx"));
});

test("test and describe titles may change, including modifiers and subtests", () => {
  const before = `test("한글 제목", () => {});\ndescribe.skip("묶음", () => {});\nit.only(\`템플릿\`, () => {});\ntest("t", async (t) => { await t.test("하위", () => {}); });\n`;
  const after = `test("English title", () => {});\ndescribe.skip("group", () => {});\nit.only(\`template\`, () => {});\ntest("t", async (t) => { await t.test("sub", () => {}); });\n`;
  assert.equal(normalizeSource(before, "x.test.ts"), normalizeSource(after, "x.test.ts"));
});

test("changes to code, string literals or assertion messages are detected", () => {
  const base = `const s = "화면 문구";\nassert.equal(x, 1, "메시지");\nfoo("인자");\n`;
  for (const changed of [
    `const s = "UI copy";\nassert.equal(x, 1, "메시지");\nfoo("인자");\n`,
    `const s = "화면 문구";\nassert.equal(x, 1, "message");\nfoo("인자");\n`,
    `const s = "화면 문구";\nassert.equal(x, 1, "메시지");\nfoo("arg");\n`,
    `const s = "화면 문구";\nassert.equal(x, 2, "메시지");\nfoo("인자");\n`,
  ]) {
    assert.notEqual(normalizeSource(base, "x.ts"), normalizeSource(changed, "x.ts"));
  }
});

test("only a test title literal is exempt, not a computed title", () => {
  const before = `test(\`제목 \${n}\`, () => {});\n`;
  const after = `test(\`title \${n}\`, () => {});\n`;
  assert.notEqual(normalizeSource(before, "x.test.ts"), normalizeSource(after, "x.test.ts"));
});

test("hangulCommentLines counts comment lines with Hangul and ignores strings", () => {
  const src = `// 한글\n// english\nconst s = "문자열";\n/* 블록\n  둘째 줄 */\n`;
  assert.equal(hangulCommentLines(src, "x.ts"), 3);
});
