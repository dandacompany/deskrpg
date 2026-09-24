import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * Reproduces exactly the condition that killed the published package: does `@/...` resolve
 * when the source lives inside `node_modules`? tsx doesn't apply tsconfig paths to files
 * inside node_modules, so without our resolver this throws Cannot find module (observed
 * 2026-09-18, 2026-09-19).
 */
function inNodeModules(body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deskrpg-alias-"));
  const pkg = path.join(root, "node_modules", "deskrpg");
  fs.mkdirSync(path.join(pkg, "src", "lib"), { recursive: true });
  fs.copyFileSync(
    path.join(import.meta.dirname, "path-alias.js"),
    path.join(pkg, "src", "lib", "path-alias.js"),
  );
  fs.writeFileSync(path.join(pkg, "src", "db.js"), "module.exports = { marker: 'db' };\n");
  fs.writeFileSync(path.join(pkg, "probe.js"), body);
  try {
    return execFileSync(process.execPath, [path.join(pkg, "probe.js")], {
      encoding: "utf8",
    }).trim();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("the @/ alias resolves to the package's src even inside node_modules", () => {
  const out = inNodeModules(`
    require("./src/lib/path-alias.js").installPathAlias(__dirname);
    console.log(require("@/db").marker);
  `);
  assert.equal(out, "db");
});

test("a non-alias request is left untouched", () => {
  const out = inNodeModules(`
    require("./src/lib/path-alias.js").installPathAlias(__dirname);
    console.log(typeof require("node:path").join);
  `);
  assert.equal(out, "function");
});

test("a nonexistent alias produces the original error as-is", () => {
  const out = inNodeModules(`
    require("./src/lib/path-alias.js").installPathAlias(__dirname);
    try { require("@/nope"); } catch (error) { console.log(error.code); }
  `);
  assert.equal(out, "MODULE_NOT_FOUND");
});

test("installing twice doesn't stack resolvers on top of each other", () => {
  const out = inNodeModules(`
    const alias = require("./src/lib/path-alias.js");
    const Module = require("node:module");
    alias.installPathAlias(__dirname);
    const first = Module._resolveFilename;
    alias.installPathAlias(__dirname);
    console.log(first === Module._resolveFilename);
  `);
  assert.equal(out, "true");
});
