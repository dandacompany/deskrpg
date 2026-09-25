import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// The socket server runs outside Next (`server.js` → src/server/**), where `next/server` does not
// resolve at runtime. Unit tests still pass because the dev install has it, so a REST helper
// pulled into the server graph only fails on a real deploy (staging crash, 2026-09-25). This walks
// the server's runtime (non-type) import graph and fails on any `next/server` import.

const ROOT = path.resolve(__dirname, "..", "..");
const SRC = path.join(ROOT, "src");
const FORBIDDEN = new Set(["next/server"]);

const IMPORT_RE =
  /^\s*(?:import|export)\s+(?!type\b)(?:[^'"]*?\sfrom\s+)?["']([^"']+)["']|require\(\s*["']([^"']+)["']\s*\)/gm;

function resolveLocal(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec);
  else return null;
  for (const cand of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    path.join(base, "index.ts"),
  ]) {
    if (existsSync(cand) && !cand.endsWith(path.sep)) {
      try {
        readFileSync(cand);
        return cand;
      } catch {
        /* a directory */
      }
    }
  }
  return null;
}

function runtimeImports(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const out: string[] = [];
  for (const m of text.matchAll(IMPORT_RE)) out.push(m[1] ?? m[2]);
  return out;
}

test("the socket server's runtime import graph never reaches next/server", () => {
  const serverDir = path.join(SRC, "server");
  const entries = readdirSync(serverDir)
    .filter((f) => /\.(ts|js)$/.test(f) && !/\.test\.ts$/.test(f))
    .map((f) => path.join(serverDir, f));
  const seen = new Set<string>();
  const parent = new Map<string, string>();
  const offenders: string[] = [];
  const stack = [...entries];
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of runtimeImports(file)) {
      if (FORBIDDEN.has(spec)) {
        const chain = [file];
        let cur = file;
        while (parent.has(cur)) chain.push((cur = parent.get(cur)!));
        offenders.push(
          chain
            .reverse()
            .map((f) => path.relative(ROOT, f))
            .join(" → "),
        );
        continue;
      }
      const next = resolveLocal(file, spec);
      if (next && !seen.has(next) && !/\.test\.tsx?$/.test(next)) {
        if (!parent.has(next)) parent.set(next, file);
        stack.push(next);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `next/server reached from the socket server:\n${offenders.join("\n")}`,
  );
});
