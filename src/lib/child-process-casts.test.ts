import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Casting a spawn result to a ChildProcess type erases the platform difference the type carries:
// with a file descriptor in stdio, Node leaves that stream null, and the cast let a null
// dereference through type checking on Windows. Let spawn's own overloads type the streams.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CAST = /\bas\s+(?:unknown\s+as\s+)?ChildProcess\w*\b/;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === "node_modules" ? [] : sources(full);
    return /\.(ts|tsx|js|cjs|mjs)$/.test(name) && !/\.test\.|\.spec\./.test(name) ? [full] : [];
  });
}

test("the guard pattern catches the cast it exists for", () => {
  assert.match("}) as ChildProcessWithoutNullStreams;", CAST);
  assert.match("child as unknown as ChildProcess", CAST);
  assert.doesNotMatch("let child: ChildProcess;", CAST);
});

test("no production code casts a spawn result to a ChildProcess type", () => {
  const offenders = [...sources(path.join(root, "src")), ...sources(path.join(root, "bin"))]
    .filter((file) => CAST.test(readFileSync(file, "utf8")))
    .map((file) => path.relative(root, file));
  assert.deepEqual(offenders, []);
});
