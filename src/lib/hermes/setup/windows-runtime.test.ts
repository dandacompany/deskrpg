/**
 * Windows runtime tests — run only on Windows (CI `windows-latest`, or by hand on a Windows box).
 *
 * Six Windows defects once passed every unit test in a row: the tests pinned argument shapes and
 * faked `spawn`, so PowerShell argument binding, the ANSI code page, ssh.exe's pipe stalls, null
 * stdio streams and ineffective chmod only showed up on a real machine. These tests run the real
 * processes instead. Payloads carry Korean text on purpose — ASCII-only payloads hid the code-page
 * defect.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  icaclsHarden,
  isOwnerOnlyAcl,
  localExecutor,
  secureStdioDir,
  setAclHarden,
} from "./executor";
import { HOST_BOOTSTRAP, hostLaunch } from "./host-helper";
import { createDefaultScan } from "./ssh-hosts";

const WINDOWS = process.platform === "win32";
const skip = WINDOWS ? false : "Windows runtime only";
const KOREAN = "한글 페이로드 — 코드 페이지 왕복";

function tempDir(prefix: string) {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

test(
  "the PowerShell launcher runs the Hermes venv Python and a Korean payload survives the round trip",
  { skip, timeout: 180_000 },
  async () => {
    // A throwaway %LOCALAPPDATA%\hermes\hermes-agent\venv stands in for a Hermes install.
    const local = tempDir("deskrpg-win-launch-");
    try {
      const venv = path.join(local, "hermes", "hermes-agent", "venv");
      execFileSync("python", ["-m", "venv", venv], { stdio: "ignore" });
      const script = [
        "import json, sys",
        `sys.stdout.buffer.write(json.dumps({'echo': ${JSON.stringify(KOREAN)}, 'exe': sys.executable}, ensure_ascii=False).encode('utf-8'))`,
      ].join("\n");
      const launch = hostLaunch("win32", "run", HOST_BOOTSTRAP, '{"error": "hermes_not_found"}');
      const result = await localExecutor(launch.command, launch.args, {
        input: JSON.stringify({ action: "discover", timeout: 60, script }),
        timeoutMs: 120_000,
        env: { ...launch.env, LOCALAPPDATA: local },
      });
      assert.equal(result.code, 0, result.stderr);
      const body = JSON.parse(result.stdout);
      assert.equal(
        body.echo,
        KOREAN,
        "the payload must come back as UTF-8, not the ANSI code page",
      );
      assert.ok(
        String(body.exe).toLowerCase().startsWith(venv.toLowerCase()),
        "the launcher must pick the Hermes venv Python",
      );
    } finally {
      rmSync(local, { recursive: true, force: true });
    }
  },
);

test(
  "ssh runs with files, not pipes, on stdin and stdout — and the payload arrives intact",
  { skip, timeout: 60_000 },
  async () => {
    // ssh.exe stalls when stdin or stdout is a Node pipe. node.exe renamed to ssh.exe on PATH reports
    // what it was actually given and echoes stdin, so the executor's real ssh branch is observed.
    const bin = tempDir("deskrpg-win-ssh-");
    try {
      copyFileSync(process.execPath, path.join(bin, "ssh.exe"));
      const probe =
        "const fs=require('fs');" +
        "const kind=(fd)=>{const s=fs.fstatSync(fd);return s.isFile()?'file':s.isFIFO()?'pipe':'other'};" +
        "process.stdout.write(JSON.stringify({stdin:kind(0),stdout:kind(1),stderr:kind(2),echo:fs.readFileSync(0,'utf8')}))";
      const result = await localExecutor("ssh", ["-e", probe], {
        input: KOREAN,
        timeoutMs: 30_000,
        env: { PATH: `${bin};${process.env.PATH ?? ""}` },
      });
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {
        stdin: "file",
        stdout: "file",
        stderr: "file",
        echo: KOREAN,
      });
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  },
);

test(
  "what ssh writes to stderr comes back, and the call ends — no stall on a stderr pipe",
  { skip, timeout: 60_000 },
  async () => {
    // ssh.exe blocks on its first stderr write when stderr is a pipe: a new host's
    // "Permanently added ... to known hosts" or a host-key/auth error then ran into command_timeout
    // (measured with OpenSSH_for_Windows_9.5p2). The fake writes to stderr and exits non-zero.
    const bin = tempDir("deskrpg-win-ssh-err-");
    try {
      copyFileSync(process.execPath, path.join(bin, "ssh.exe"));
      const probe =
        "process.stderr.write('Warning: Permanently added host to the list of known hosts.\\n');" +
        "process.exit(255)";
      const started = Date.now();
      const result = await localExecutor("ssh", ["-e", probe], {
        input: "{}",
        timeoutMs: 30_000,
        env: { PATH: `${bin};${process.env.PATH ?? ""}` },
      });
      assert.equal(result.code, 255);
      assert.match(result.stderr, /Permanently added/);
      assert.ok(Date.now() - started < 15_000, "the call waited on stderr");
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  },
);

test(
  "the ssh stdio directory grants only the current user — the ACL is really narrowed",
  { skip },
  () => {
    // Every read-back is kept for the failure message: CI showed only "acl_not_narrowed" once, and
    // the runner's actual icacls output is the evidence (runner accounts only — nothing secret).
    const seen: string[] = [];
    let dir: string;
    try {
      dir = secureStdioDir("win32", undefined, undefined, (d) => {
        const out = execFileSync("icacls", [d], { encoding: "utf8" });
        seen.push(out);
        return out;
      });
    } catch (error) {
      assert.fail(`${String(error)}\n--- icacls read-backs ---\n${seen.join("\n---\n")}`);
    }
    try {
      const file = path.join(dir, "stdout.out");
      writeFileSync(file, "token");
      const acl = execFileSync("icacls", [file], { encoding: "utf8" });
      const principals = acl
        .split(/\r?\n/)
        .map((line) => line.replace(file, "").trim())
        .filter((line) => line.includes(":(") && !/Mandatory Label\\/i.test(line))
        .map((line) => line.slice(0, line.indexOf(":(")).toLowerCase());
      assert.deepEqual(
        [...new Set(principals)].map((p) => p.split("\\").pop()),
        [os.userInfo().username.toLowerCase()],
        acl,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("Set-Acl alone narrows the ssh stdio directory — read back", { skip }, () => {
  const dir = tempDir("deskrpg-acl-way-");
  try {
    let error = "";
    try {
      setAclHarden(dir);
    } catch (e) {
      error = String(e);
    }
    const acl = execFileSync("icacls", [dir], { encoding: "utf8" });
    assert.ok(isOwnerOnlyAcl(acl), `Set-Acl did not narrow${error ? ` (${error})` : ""}:\n${acl}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Not an assertion: icacls does not narrow on every host (windows-latest keeps explicit entries), and
// secureStdioDir falls back to Set-Acl there. Its outcome is kept in the log for comparison.
test("icacls alone — outcome recorded, not required", { skip }, (t) => {
  const dir = tempDir("deskrpg-acl-way-");
  try {
    try {
      icaclsHarden(dir);
    } catch (e) {
      t.diagnostic(`icacls threw: ${String(e)}`);
    }
    const acl = execFileSync("icacls", [dir], { encoding: "utf8" });
    t.diagnostic(`icacls narrowed: ${isOwnerOnlyAcl(acl)}\n${acl}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "start -d on Windows creates the server outside this process tree, through WMI",
  { skip, timeout: 60_000 },
  async () => {
    const { launchWindowsDaemon } = await import("../../windows-daemon.js");
    const home = tempDir("deskrpg win daemon ");
    const server = path.join(home, "fake-cli.js");
    writeFileSync(
      server,
      "const http=require('http'),fs=require('fs'),path=require('path');" +
        "const port=Number(process.argv[process.argv.indexOf('-p')+1]);" +
        "http.createServer((q,r)=>{r.statusCode=307;r.end()}).listen(port,'127.0.0.1',()=>" +
        "fs.writeFileSync(path.join(process.env.DESKRPG_HOME,'deskrpg.pid'),String(process.pid)));",
    );
    const port = 38000 + Math.floor(Math.random() * 1000);
    let pid = 0;
    try {
      launchWindowsDaemon(
        {
          nodePath: process.execPath,
          cliPath: server,
          logFile: path.join(home, "daemon.log"),
          env: { DESKRPG_HOME: home },
          args: ["-p", String(port)],
          cwd: home,
        },
        spawnSync,
      );
      const pidFile = path.join(home, "deskrpg.pid");
      for (let i = 0; i < 200 && !existsSync(pidFile); i++)
        await new Promise((r) => setTimeout(r, 100));
      pid = Number(readFileSync(pidFile, "utf8"));
      const status = await new Promise<number>((resolve, reject) =>
        http
          .get({ host: "127.0.0.1", port, path: "/" }, (res) => resolve(res.statusCode ?? 0))
          .on("error", reject),
      );
      assert.equal(status, 307);
      // A detached spawn would still be ours; the WMI-created one has a parent outside our tree.
      const parent = execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`,
        ],
        { encoding: "utf8" },
      ).trim();
      const ancestors = new Set([String(process.pid)]);
      assert.ok(!ancestors.has(parent), `server parent ${parent} must not be this test process`);
    } finally {
      if (pid) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
      await new Promise((r) => setTimeout(r, 500));
      rmSync(home, { recursive: true, force: true });
    }
  },
);

test(
  "ssh-keyscan against a closed port ends within its limit instead of stalling",
  { skip, timeout: 30_000 },
  async () => {
    const started = Date.now();
    await assert.rejects(
      createDefaultScan()({ host: "127.0.0.1", port: 1, user: "nobody" }),
      /ssh_/,
    );
    assert.ok(Date.now() - started < 12_000, `took ${Date.now() - started}ms`);
  },
);

test(
  "killing a process tree on Windows takes the grandchildren too",
  { skip, timeout: 30_000 },
  async () => {
    const { killProcessTree } = await import("./executor");
    const parent = spawn("cmd.exe", ["/d", "/c", "ping -n 60 127.0.0.1 >nul"], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 1000));
    const children = () =>
      execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${parent.pid}").ProcessId`,
        ],
        { encoding: "utf8" },
      )
        .split(/\s+/)
        .filter(Boolean);
    const before = children();
    assert.ok(before.length > 0, "ping must be running under cmd");
    killProcessTree(
      parent.pid!,
      "win32",
      (pid, signal) => process.kill(pid, signal as NodeJS.Signals),
      (command, args) => execFileSync(command, args, { stdio: "ignore" }),
    );
    await new Promise((r) => setTimeout(r, 1000));
    for (const pid of before) {
      const alive = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], {
        encoding: "utf8",
      }).stdout;
      assert.ok(!alive.includes(pid), `grandchild ${pid} must be gone`);
    }
  },
);
