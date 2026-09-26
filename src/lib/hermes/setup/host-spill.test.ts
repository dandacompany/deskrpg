import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";

import { HOST_BOOTSTRAP } from "./host-helper";

// A reply larger than the transport's budget is written to a private directory on the host and
// fetched with scp (Windows ssh.exe cannot deliver more than 64 KiB on stdout). These tests run the
// bootstrap's Python directly: the spill, its permissions, cleanup and the orphan sweep.

const POSIX = process.platform !== "win32";

function sandbox(tempName = "tmp") {
  const root = mkdtempSync(join(tmpdir(), "deskrpg-spill-test-"));
  const home = join(root, "home");
  const temp = join(root, tempName);
  mkdirSync(temp, { recursive: true });
  const venv = spawnSync(
    "python3",
    ["-m", "venv", "--without-pip", join(home, ".hermes/hermes-agent/venv")],
    { encoding: "utf8", timeout: 20000 },
  );
  assert.equal(venv.status, 0, venv.stderr);
  const run = (payload: Record<string, unknown>) => {
    const result = spawnSync("python3", ["-c", HOST_BOOTSTRAP], {
      encoding: "utf8",
      input: JSON.stringify(payload),
      env: { ...process.env, HOME: home, TMPDIR: temp, TEMP: temp, TMP: temp },
      timeout: 30000,
    });
    return JSON.parse(result.stdout) as Record<string, unknown>;
  };
  return { root, temp, run, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

const bigReply = (size: number) => ({
  action: "run",
  timeout: 20,
  max_output: 100,
  script: `import sys; sys.stdout.write('{"token": "' + 'x' * ${size} + '"}')`,
});

test("an oversized reply is refused as before when the client cannot fetch a file", () => {
  const box = sandbox();
  try {
    assert.deepEqual(box.run(bigReply(500)), { error: "host_output_too_large" });
  } finally {
    box.dispose();
  }
});

test("with spill on, an oversized reply lands in a private, unguessable file in the temp dir", () => {
  const box = sandbox();
  try {
    const reply = box.run({ ...bigReply(500), spill: true });
    const file = String(reply.spill);
    const expected = Buffer.from(`{"token": "${"x".repeat(500)}"}`);
    assert.equal(reply.bytes, expected.length);
    assert.equal(reply.sha256, createHash("sha256").update(expected).digest("hex"));
    assert.equal(JSON.stringify(reply).includes("xxxx"), false, "the pointer carries no content");
    assert.match(basename(file), /^[0-9a-f]{32}$/);
    assert.match(basename(dirname(file)), /^deskrpg-spill-/);
    assert.equal(dirname(dirname(file)), box.temp);
    assert.deepEqual(readFileSync(file), expected);
    if (POSIX) {
      assert.equal(statSync(dirname(file)).mode & 0o077, 0, "the directory is owner-only");
      assert.equal(statSync(file).mode & 0o077, 0, "the file is owner-only");
    }
  } finally {
    box.dispose();
  }
});

test("cleanup removes the spill directory and says so", () => {
  const box = sandbox();
  try {
    const file = String(box.run({ ...bigReply(500), spill: true }).spill);
    assert.deepEqual(box.run({ cleanup_spill: file }), { cleaned: true });
    assert.equal(existsSync(dirname(file)), false);
  } finally {
    box.dispose();
  }
});

test("cleanup refuses anything that is not a spill directory in the temp dir", () => {
  const box = sandbox();
  try {
    const decoy = join(box.root, "deskrpg-spill-decoy");
    mkdirSync(decoy);
    const name = "a".repeat(32);
    for (const path of [
      join(decoy, name), // right shape, outside the temp dir
      join(box.temp, "not-a-spill", name), // wrong directory prefix
      join(box.temp, "deskrpg-spill-x", "reply.json"), // wrong file name
      "relative/deskrpg-spill-x/" + name,
    ]) {
      assert.deepEqual(
        box.run({ cleanup_spill: path }),
        { error: "host_spill_cleanup_failed" },
        path,
      );
    }
    assert.ok(existsSync(decoy), "the decoy outside the temp dir is untouched");
  } finally {
    box.dispose();
  }
});

test("a new spill sweeps this user's spill directories older than 15 minutes", () => {
  const box = sandbox();
  try {
    const stale = join(box.temp, "deskrpg-spill-stale");
    const fresh = join(box.temp, "deskrpg-spill-fresh");
    const other = join(box.temp, "unrelated-old");
    for (const dir of [stale, fresh, other]) mkdirSync(dir);
    const old = new Date(Date.now() - 20 * 60 * 1000);
    utimesSync(stale, old, old);
    utimesSync(other, old, old);
    box.run({ ...bigReply(500), spill: true });
    assert.equal(existsSync(stale), false);
    assert.ok(existsSync(fresh));
    assert.ok(existsSync(other));
  } finally {
    box.dispose();
  }
});

const spillDirs = (temp: string) =>
  readdirSync(temp).filter((name) => name.startsWith("deskrpg-spill-"));

test("a reply over the spill cap is refused instead of spilled", () => {
  const box = sandbox();
  try {
    assert.deepEqual(box.run({ ...bigReply(500), spill: true, max_spill: 200 }), {
      error: "host_output_too_large",
    });
    assert.deepEqual(spillDirs(box.temp), []);
  } finally {
    box.dispose();
  }
});

test("no spill is made under a temp path an old scp would hand to a shell", () => {
  // scp before OpenSSH 9.0 passes the remote path through the remote shell.
  const box = sandbox("tmp with space");
  try {
    assert.deepEqual(box.run({ ...bigReply(500), spill: true }), {
      error: "host_output_too_large",
    });
    assert.deepEqual(spillDirs(box.temp), []);
  } finally {
    box.dispose();
  }
});

test("every run sweeps stale spills, not only the next spill", () => {
  const box = sandbox();
  try {
    const old = new Date(Date.now() - 20 * 60 * 1000);
    const stale = join(box.temp, "deskrpg-spill-stale");
    mkdirSync(stale);
    utimesSync(stale, old, old);
    box.run({ action: "run", timeout: 20, max_output: 1000, script: "print('{}')" });
    assert.equal(existsSync(stale), false, "a plain run sweeps");

    mkdirSync(stale);
    utimesSync(stale, old, old);
    box.run({ cleanup_spill: join(box.temp, "deskrpg-spill-gone", "a".repeat(32)) });
    assert.equal(existsSync(stale), false, "a cleanup call sweeps");
  } finally {
    box.dispose();
  }
});
