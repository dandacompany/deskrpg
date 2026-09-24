import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { DEV_JWT_SECRET } from "./dev-constants";

test("DEV_JWT_SECRET is a non-empty string", () => {
  assert.equal(typeof DEV_JWT_SECRET, "string");
  assert.ok(DEV_JWT_SECRET.length > 0);
  assert.ok(DEV_JWT_SECRET.includes("do-not-use-in-production"));
});

/**
 * This test originally `await import`ed two modules under the name "consistent across imports,"
 * but **never used the imported values** — it just repeated the same assertion as the test
 * above. In other words, it never once verified what its name claimed, and no regression could
 * ever have turned it red (discovered 2026-09-08).
 *
 * Sharing is structurally guaranteed — both `jwt.ts` and `gateway-resources.ts` import from
 * `./dev-constants`. There's exactly one way to break it: someone rewrites that literal in their
 * own file. Then only one side's secret changes and tokens silently stop matching. So that's
 * what's checked here.
 */
test("the dev secret literal exists only in dev-constants.ts", () => {
  const libDir = path.dirname(fileURLToPath(import.meta.url));
  const srcDir = path.resolve(libDir, "..");
  const offenders: string[] = [];

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx|js|cjs|mjs)$/.test(entry.name)) continue;
      if (full === path.join(libDir, "dev-constants.ts")) continue;
      if (full === fileURLToPath(import.meta.url)) continue;
      if (readFileSync(full, "utf8").includes(DEV_JWT_SECRET)) {
        offenders.push(path.relative(srcDir, full));
      }
    }
  };
  walk(srcDir);

  assert.deepEqual(
    offenders,
    [],
    "개발용 비밀을 직접 적은 파일이 있습니다 — dev-constants 에서 가져오세요:\n  " +
      offenders.join("\n  "),
  );
});
