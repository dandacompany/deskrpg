import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * Starting from `"use client"` files, follows imports to check whether any path pulls a
 * server-only module into the client bundle.
 *
 * Why this test exists: a real incident of exactly this kind happened. When
 * `plugin-capability.ts` imported `@/db`, pg and better-sqlite3 got bundled into the
 * browser and the screen went blank. Neither `npm run test` nor `tsc` catches it — the
 * types are correct, and the runtime only ever runs on the server. The bundler's
 * tree-shaking sometimes hides it too, so "it's not broken right now" is not proof.
 */

const SRC = path.join(process.cwd(), "src");
const SERVER_ONLY_SPECIFIERS = [
  /^node:/,
  /^@\/db(\/|$)/,
  /^better-sqlite3$/,
  /^pg$/,
  /^drizzle-orm\/node-postgres$/,
];

function listFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name))
      out.push(full);
  }
  return out;
}

const IMPORT_RE = /(?:^|\n)\s*import\s+(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']/g;

function importsOf(file: string): string[] {
  const src = fs.readFileSync(file, "utf8");
  const found: string[] = [];
  for (const m of src.matchAll(IMPORT_RE)) found.push(m[1]);
  return found;
}

function resolve(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(fromFile), spec);
  else return null; // an external package is not followed to a file
  for (const cand of [
    base + ".ts",
    base + ".tsx",
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ]) {
    if (fs.existsSync(cand)) return cand;
  }
  return null;
}

function isServerOnly(spec: string): boolean {
  return SERVER_ONLY_SPECIFIERS.some((re) => re.test(spec));
}

test("no import path from a client component reaches a server-only module", () => {
  const files = listFiles(SRC);
  const clientEntries = files.filter((f) => {
    const head = fs.readFileSync(f, "utf8").slice(0, 200);
    return /^\s*["']use client["']/.test(head);
  });
  assert.ok(clientEntries.length > 0, '"use client" 파일을 하나도 못 찾았다 — 탐색이 깨졌다');

  const violations: string[] = [];
  for (const entry of clientEntries) {
    const seen = new Set<string>();
    // [file, path taken to get here]
    const stack: Array<[string, string[]]> = [[entry, [path.relative(SRC, entry)]]];
    while (stack.length > 0) {
      const [file, trail] = stack.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const spec of importsOf(file)) {
        if (isServerOnly(spec)) {
          violations.push(`${trail.join(" → ")} → ${spec}`);
          continue;
        }
        const next = resolve(spec, file);
        if (next) stack.push([next, [...trail, path.relative(SRC, next)]]);
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    `클라이언트 번들이 서버 전용 모듈을 끌어온다:\n  ${violations.join("\n  ")}`,
  );
});
