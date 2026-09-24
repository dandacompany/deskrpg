import assert from "node:assert/strict";
import test from "node:test";

import { findHangul, scanRepository } from "./check-hangul-literals";

const kinds = (text: string, file: string) => findHangul(text, file).map((hit) => hit.kind);

test("flags Hangul string literals, JSX text and comments outside the allowlist", () => {
  assert.deepEqual(kinds(`const a = "안녕";\n`, "src/x.ts"), ["literal"]);
  assert.deepEqual(kinds(`const A = () => <p>안녕</p>;\n`, "src/x.tsx"), ["literal"]);
  assert.deepEqual(kinds(`// 설명하는 주석\nconst a = 1;\n`, "src/x.ts"), ["comment"]);
});

test("allows Hangul inside a ko block or a ko variable", () => {
  assert.deepEqual(kinds(`const M = { ko: { a: "안녕" }, en: { a: "hi" } };\n`, "src/x.ts"), []);
  assert.deepEqual(kinds(`const L = { nameKo: "종합상사" };\n`, "src/x.ts"), []);
  assert.deepEqual(kinds(`const ko = { a: "안녕" };\n`, "src/x.ts"), []);
});

test("allows a comment that only quotes exact Korean UI text", () => {
  assert.deepEqual(
    kinds(`// Shows "계속 켭니다 [끄기]" after an update.\nconst a = 1;\n`, "src/x.ts"),
    [],
  );
  assert.deepEqual(kinds(`// Matches \`[대화 상대]\` headers.\nconst a = 1;\n`, "src/x.ts"), []);
  assert.deepEqual(
    kinds(`// Pressing [설정에서 켜기] turns it on.\nconst a = 1;\n`, "src/x.ts"),
    [],
  );
});

test("allowlisted paths are not scanned", () => {
  assert.deepEqual(kinds(`const a = "안녕";\n`, "src/lib/i18n/locales/ko.ts"), []);
  assert.deepEqual(kinds(`const a = "안녕";\n`, "src/x.test.ts"), []);
  assert.deepEqual(kinds(`const a = "안녕";\n`, "e2e/x.spec.ts"), []);
});

test("the repository has no Hangul outside the allowlist", () => {
  assert.deepEqual(scanRepository(), []);
});
