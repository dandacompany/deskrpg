import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * Check that the `npm run test` glob **actually picks up every test file**.
 *
 * Why it is needed: in globs brackets are character classes. `src/**\/*.test.ts` cannot pass through Next's dynamic route
 * folders (`[id]`, `[name]`), so tests inside them looked green **without ever running**
 * (2026-09-18 measurement: 3 in `src/app/api/npcs/[id]/placement-route.test.ts`).
 * A test that does not run is worse than no test — it makes you believe it exists.
 */
test("the test glob picks up every test file in src", () => {
  const root = process.cwd();
  const script = String(
    (
      JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
        scripts: Record<string, string>;
      }
    ).scripts.test,
  );
  const patterns = [...script.matchAll(/"([^"]*\*[^"]*)"/g)].map((match) => match[1]);
  assert.ok(patterns.length > 0, "test 스크립트에서 글롭을 찾지 못했다");

  // `fs.globSync` exists in Node 22 but @types/node does not expose it yet.
  const globSync = (
    fs as unknown as {
      globSync: (pattern: string, options: { cwd: string }) => string[];
    }
  ).globSync;
  const matched = new Set<string>();
  for (const pattern of patterns) {
    for (const file of globSync(pattern, { cwd: root })) matched.add(String(file));
  }

  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (/\.test\.(ts|tsx|js)$/.test(entry.name)) found.push(rel);
    }
  };
  walk("src");

  const missed = found.filter((file) => !matched.has(file));
  assert.deepEqual(missed, [], `글롭이 지나친 테스트 파일: ${missed.join(", ")}`);
});
