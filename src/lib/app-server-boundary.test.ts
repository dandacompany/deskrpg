import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * Next app code (`src/app/**`, `src/lib/**`) doesn't import the socket server modules
 * (`src/server/**`).
 *
 * Why this test is needed: a real incident happened. When `kanban-routes.ts` imported
 * `@/server/automation-events` and the gateway route imported `@/server/automation-poller`,
 * `socket-handlers.ts` got pulled into the Next/Turbopack bundle, and that file's `.js`
 * -extension relative imports (meant for the tsx runtime) broke `npm run build` with 5
 * "Module not found" errors. Neither `npm run test` nor `tsc` catches this.
 *
 * When a route needs socket-server-side functionality, it goes through a `globalThis`
 * registry like `automation-registry.ts` (same pattern as `rpc-registry.ts`). Even when only
 * a type is needed, it's placed in lib, not in a server module.
 */

const SRC = path.join(process.cwd(), "src");
const SCAN_DIRS = ["app", "lib"].map((d) => path.join(SRC, d));

function listFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name))
      out.push(full);
  }
  return out;
}

// Looks at both static imports and dynamic import() — the bundler follows dynamic ones too.
const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\s+(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

function importsOf(file: string): string[] {
  const src = fs.readFileSync(file, "utf8");
  const found: string[] = [];
  for (const m of src.matchAll(IMPORT_RE)) found.push(m[1] ?? m[2]);
  return found;
}

function pointsAtServer(spec: string, fromFile: string): boolean {
  if (/^@\/server(\/|$)/.test(spec)) return true;
  if (!spec.startsWith(".")) return false;
  const target = path.resolve(path.dirname(fromFile), spec);
  const rel = path.relative(path.join(SRC, "server"), target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

test("src/app and src/lib don't import src/server", () => {
  const files = SCAN_DIRS.flatMap((d) => listFiles(d));
  assert.ok(files.length > 50, `탐색이 깨졌다 — 파일 ${files.length}개만 찾았다`);

  const violations: string[] = [];
  for (const file of files) {
    for (const spec of importsOf(file)) {
      if (pointsAtServer(spec, file)) violations.push(`${path.relative(SRC, file)} → ${spec}`);
    }
  }

  assert.deepEqual(
    violations,
    [],
    `Next 앱 코드가 소켓 서버 모듈을 끌어온다 (빌드가 깨진다 — 레지스트리를 거칠 것):\n  ${violations.join("\n  ")}`,
  );
});
