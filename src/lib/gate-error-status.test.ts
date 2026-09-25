import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { classifyGateFailure } from "./gate-failure";
import { GATE_ERROR_STATUS, findGateStatusMismatches } from "./gate-error-status";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

test("every gate code the screen classifies has exactly one status", () => {
  for (const [code, status] of Object.entries(GATE_ERROR_STATUS)) {
    const blocker = classifyGateFailure({ status, code });
    assert.notEqual(blocker.kind, "other", `${code} must map to a checklist step`);
  }
});

// The screen's gate classifier branches on `code` alone, so the promise "this code always comes with
// this status" lives only in the server's call sites. This scan holds every literal pair to the table.
test("no source file sends a gate code with a status other than the table's", () => {
  const mismatches = sourceFiles(SRC).flatMap((file) =>
    findGateStatusMismatches(readFileSync(file, "utf8")).map(
      (m) => `${path.relative(SRC, file)}: ${m.code} sent as ${m.status}, table says ${m.expected}`,
    ),
  );
  assert.deepEqual(mismatches, []);
});

test("the scan catches a route that sends plugin_absent as something other than 404", () => {
  const route = `return cronError(\n  503,\n  "plugin_absent",\n  "not installed",\n);`;
  assert.deepEqual(findGateStatusMismatches(route), [
    { code: "plugin_absent", status: 503, expected: 404 },
  ]);
  assert.deepEqual(findGateStatusMismatches(`cronError(404, "plugin_absent", "x")`), []);
  assert.deepEqual(findGateStatusMismatches(`cronError(400, "invalid_field", "x")`), []);
});
