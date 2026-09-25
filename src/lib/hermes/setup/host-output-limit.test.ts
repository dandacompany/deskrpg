import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { sshStdoutLimit, WINDOWS_SSH_STDOUT_LIMIT } from "./executor";
import { discoverHost, inspectHost } from "./host";
import { HOST_BOOTSTRAP } from "./host-helper";
import type { HostExecutor } from "./types";

// Windows' ssh.exe (Win32-OpenSSH 9.5p2) stops delivering stdout after two 32 KiB channel packets:
// up to 65536 bytes it exits normally, up to 98304 it delivers everything but never exits, and past
// that it stalls at 98304. Measured with the stdout as a Node file fd, a cmd.exe redirect and a pipe
// alike, so no client-side stdio choice avoids it. Larger replies must fail with a named code instead
// of running into command_timeout.

function recording(stdout: string, limit?: number) {
  const inputs: Record<string, unknown>[] = [];
  const execute: HostExecutor = Object.assign(
    async (_command: string, _args: string[], options?: { input?: string }) => {
      inputs.push(JSON.parse(options?.input ?? "{}"));
      return { code: 0, stdout, stderr: "" };
    },
    limit === undefined ? {} : { stdoutLimit: limit },
  );
  return { execute, inputs };
}

test("Windows ssh caps a reply at two channel packets; other clients keep the helper's cap", () => {
  assert.equal(WINDOWS_SSH_STDOUT_LIMIT, 65536);
  assert.equal(sshStdoutLimit("win32"), 65536);
  assert.equal(sshStdoutLimit("linux"), undefined);
  assert.equal(sshStdoutLimit("darwin"), undefined);
});

test("the helper is told the transport's reply budget", async () => {
  const plain = recording(JSON.stringify({ candidates: [] }));
  await discoverHost(plain.execute);
  assert.equal(plain.inputs[0].max_output, 262144);

  const windowsSsh = recording(JSON.stringify({ candidates: [] }), 65536);
  await discoverHost(windowsSsh.execute);
  assert.equal(windowsSsh.inputs[0].max_output, 65536);
});

test("a reply over the budget, or the helper saying so, is host_output_too_large", async () => {
  const oversize = recording(JSON.stringify({ padding: "x".repeat(70000) }), 65536);
  await assert.rejects(discoverHost(oversize.execute), /^Error: host_output_too_large$/);

  const refused = recording(JSON.stringify({ error: "host_output_too_large" }), 65536);
  await assert.rejects(
    inspectHost(refused.execute, "a".repeat(64)),
    /^Error: host_output_too_large$/,
  );
});

test("the bootstrap refuses a reply larger than max_output instead of sending it", () => {
  const temp = mkdtempSync(join(tmpdir(), "deskrpg-output-limit-test-"));
  try {
    const venv = spawnSync(
      "python3",
      ["-m", "venv", "--without-pip", join(temp, ".hermes/hermes-agent/venv")],
      { encoding: "utf8", timeout: 20000 },
    );
    assert.equal(venv.status, 0, venv.stderr);
    const run = (size: number, maxOutput: number) =>
      spawnSync("python3", ["-c", HOST_BOOTSTRAP], {
        encoding: "utf8",
        input: JSON.stringify({
          action: "run",
          timeout: 20,
          max_output: maxOutput,
          // Two-byte characters: the budget counts bytes on the wire, not characters.
          script: `import sys; sys.stdout.write('\u00e9' * ${size})`,
        }),
        env: { ...process.env, HOME: temp },
        timeout: 30000,
      });
    const within = run(30, 100);
    assert.equal(within.stdout, "\u00e9".repeat(30));
    const over = run(60, 100); // 60 characters, 120 bytes
    assert.deepEqual(JSON.parse(over.stdout), { error: "host_output_too_large" });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
