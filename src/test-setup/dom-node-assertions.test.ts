import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { booleanForm, findDomNodeAssertions } from "./dom-node-assertions";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** This file — its fixtures spell out the shapes on purpose. */
const SELF = "test-setup/dom-node-assertions.test.ts";

/**
 * Files another branch is editing right now. Remove an entry once that file is converted — the
 * list must only shrink.
 */
const PENDING = new Set<string>();

function testFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return testFiles(full);
    return /\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

test("no test compares a DOM node as a value (a failure would hang the file)", () => {
  const offenders = testFiles(SRC).flatMap((file) => {
    const rel = path.relative(SRC, file).split(path.sep).join("/");
    if (rel === SELF || PENDING.has(rel)) return [];
    return findDomNodeAssertions(readFileSync(file, "utf8")).map(
      (hit) => `${rel}:${hit.line} assert.${hit.method}(${hit.subject}, ${hit.expected})`,
    );
  });
  assert.deepEqual(offenders, [], "assert on a boolean instead: assert.ok(!node)");
});

test("the pending list names only files that still need converting", () => {
  for (const rel of PENDING) {
    const hits = findDomNodeAssertions(readFileSync(path.join(SRC, rel), "utf8"));
    assert.ok(hits.length > 0, `${rel} is clean — drop it from PENDING`);
  }
});

test("the scan reads the shapes that hang and leaves plain values alone", () => {
  const source = [
    `assert.equal(host.querySelector("[data-x]"), null);`,
    `assert.strictEqual(\n  el.closest("li"),\n  undefined,\n  "no row",\n);`,
    `assert.equal(rows.find((r) => r.id === "a")?.notice, null);`,
    `assert.equal(host.querySelector("x")?.textContent, "hi");`,
    `assert.ok(!host.querySelector("x"));`,
  ].join("\n");
  const hits = findDomNodeAssertions(source);
  assert.deepEqual(
    hits.map((h) => [h.method, h.expected, h.message]),
    [
      ["equal", "null", null],
      ["strictEqual", "undefined", '"no row"'],
    ],
  );
  assert.equal(booleanForm(hits[0]), `assert.ok(!host.querySelector("[data-x]"))`);
  assert.equal(booleanForm(hits[1]), `assert.ok(!el.closest("li"), "no row")`);
});
