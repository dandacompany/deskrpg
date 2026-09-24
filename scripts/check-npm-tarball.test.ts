import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

function checkTarball(paths: string[], maxBytes?: number) {
  const root = mkdtempSync(path.join(tmpdir(), "deskrpg-package-gate-"));
  try {
    for (const name of paths) {
      const file = path.join(root, name);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, "fixture");
    }
    const archive = path.join(root, "fixture.tgz");
    const packed = spawnSync("tar", ["-czf", archive, "package"], {
      cwd: root,
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    assert.equal(packed.status, 0, packed.stderr.toString());
    const command =
      maxBytes === undefined
        ? ["scripts/check-npm-tarball.py", archive]
        : [
            "-c",
            "import importlib.util, pathlib, sys; s=importlib.util.spec_from_file_location('gate', sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); m.MAX_UNPACKED_BYTES=int(sys.argv[3]); sys.exit(m.check(pathlib.Path(sys.argv[2])))",
            "scripts/check-npm-tarball.py",
            archive,
            String(maxBytes),
          ];
    return spawnSync("python3", command, {
      cwd: process.cwd(),
      encoding: "utf8",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("the npm tarball checker rejects development files and guidelines", () => {
  for (const name of [
    "package/.next/standalone/src/lib/x.test.mjs",
    "package/.next/standalone/src/lib/x.test.d.ts",
    "package/src/lib/x.spec.cjs",
    "package/.next/standalone/AGENTS.md",
    "package/.next/standalone/src/lib/AGENTS.md",
    "package/.next/standalone/docs/plan.md",
    "package/.next/standalone/playwright.fixtures.config.ts",
    "package/.next/standalone/tsconfig.tsbuildinfo",
    "package/.next/standalone/src/test-setup/dom.ts",
  ]) {
    const result = checkTarball([name]);
    assert.equal(result.status, 1, name);
    assert.match(result.stderr, /Forbidden development files/);
  }
});

test("the npm tarball checker allows dependency runtime scripts", () => {
  const result = checkTarball([
    "package/.next/standalone/node_modules/pkg/scripts/runtime.js",
    "package/.next/standalone/node_modules/pkg/playwright.config.js",
    "package/.next/standalone/node_modules/pkg/test-setup/runtime.js",
  ]);
  assert.equal(result.status, 0, result.stderr);
});

test("the npm tarball checker enforces the size limit", () => {
  const result = checkTarball(["package/server.js"], 1);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unpacked size exceeds/);
});
