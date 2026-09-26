import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  createExecutor,
  getSshHosts,
  sshExecutor,
  quoteShellArg,
  killProcessTree,
  secureStdioDir,
  isOwnerOnlyAcl,
} from "./executor";

// getSshHosts reads the registered hosts under DESKRPG_HOME. Point it at an empty directory so the
// machine running the tests (a developer box, or a Windows host with real registrations) cannot
// leak its own hosts into the expectations.
process.env.DESKRPG_HOME = mkdtempSync(path.join(os.tmpdir(), "deskrpg-executor-home-"));
function fake() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: false,
    kill() {
      this.killed = true;
      return true;
    },
  });
  return child as unknown as ChildProcessWithoutNullStreams;
}
test("SSH aliases must be explicitly opted in and arguments remain one quoted command", async () => {
  process.env.DESKRPG_SETUP_SSH_HOSTS = "test-host, -oProxyCommand=bad, test-host";
  assert.deepEqual(getSshHosts(), [{ id: "test-host", label: "test-host" }]);
  assert.throws(() => sshExecutor("unknown"), /ssh_unknown_host/);
  assert.throws(() => sshExecutor("-oProxyCommand=bad"), /ssh_unknown_host/);
  let recorded: string[] = [];
  const executor = sshExecutor("test-host", async (command, args) => {
    assert.equal(command, "ssh");
    recorded = args;
    return { stdout: "", stderr: "", code: 0 };
  });
  await executor("python3", ["-c", "print('safe'); $(touch /tmp/no)"]);
  assert.ok(recorded.includes("StrictHostKeyChecking=yes"));
  assert.ok(recorded.includes("BatchMode=yes"));
  assert.equal(
    recorded.at(-1),
    ["python3", "-c", "print('safe'); $(touch /tmp/no)"].map(quoteShellArg).join(" "),
  );
  await assert.rejects(executor("python3;evil", []), /setup_invalid_request/);
});
test("SSH identity failures redact raw stderr", async () => {
  process.env.DESKRPG_SETUP_SSH_HOSTS = "test-host";
  const executor = sshExecutor("test-host", async () => ({
    stdout: "",
    stderr: "SECRET Host key verification failed",
    code: 255,
  }));
  await assert.rejects(
    executor("true", []),
    (error) =>
      error instanceof Error &&
      /ssh_host_key_failed/.test(error.message) &&
      !error.message.includes("SECRET"),
  );
});
test("a rejected key is reported as an auth failure, not a connection failure — stderr is not included", async () => {
  process.env.DESKRPG_SETUP_SSH_HOSTS = "test-host";
  const executor = sshExecutor("test-host", async () => ({
    stdout: "",
    stderr: "SECRET dante@host.docker.internal: Permission denied (publickey).",
    code: 255,
  }));
  await assert.rejects(
    executor("true", []),
    (error) =>
      error instanceof Error &&
      error.message === "ssh_auth_failed" &&
      !error.message.includes("SECRET"),
  );
});
test("bounded subprocess timeouts and cancellation stop owned process", async () => {
  const child = fake();
  await assert.rejects(
    createExecutor(() => child)("python3", [], { timeoutMs: 5 }),
    /command_timeout/,
  );
  assert.ok(child.killed);
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(
    createExecutor(() => {
      throw new Error("must not spawn");
    })("python3", [], { signal: cancelled.signal }),
    /setup_cancelled/,
  );
});
test("oversized output is rejected and normal output stays internal", async () => {
  const child = fake();
  const result = createExecutor(() => child)("python3", []);
  child.stdout.emit("data", Buffer.alloc(1024 * 1024 + 1));
  await assert.rejects(result, /output_limit/);
  assert.ok(child.killed);
  const other = fake();
  const normal = createExecutor(() => other)("python3", [], { input: "private" });
  other.stdout.emit("data", Buffer.from("answer"));
  other.emit("close", 0);
  assert.deepEqual(await normal, { stdout: "answer", stderr: "", code: 0 });
});

test("win32 cuts the tree with taskkill", () => {
  const runs: [string, string[]][] = [];
  killProcessTree(
    4242,
    "win32",
    () => assert.fail("직계만 죽이면 안 된다"),
    (c: string, a: string[]) => runs.push([c, a]),
  );
  assert.deepEqual(runs, [["taskkill", ["/PID", "4242", "/T", "/F"]]]);
});

test("if taskkill fails on win32, at least the direct child is killed", () => {
  const killed: number[] = [];
  killProcessTree(
    7,
    "win32",
    (pid: number) => killed.push(pid),
    () => {
      throw new Error("taskkill missing");
    },
  );
  assert.deepEqual(killed, [7]);
});

test("non-win32 kills the process group", () => {
  const killed: [number, string][] = [];
  killProcessTree(
    9,
    "linux",
    (pid: number, signal: string) => killed.push([pid, signal]),
    () => assert.fail("taskkill을 쓰면 안 된다"),
  );
  assert.deepEqual(killed, [[-9, "SIGKILL"]]);
});

test("executor source: win32 ssh takes stdin/stdout as file fds, and the types don't hide null", () => {
  // process.platform can't be changed, so this branch doesn't run on macOS. We pin it by structure.
  // Real behavior was confirmed on WinServer (stdin/stdout files, SSH discover 849ms).
  const source = readFileSync(new URL("./executor.ts", import.meta.url), "utf-8");
  assert.match(
    source,
    /const stdio: StdioOptions = \[\s*stdinFd !== undefined \? stdinFd : "pipe",\s*stdoutFd,/,
    "파일 갈래의 stdio 는 파이프가 아니라 파일 fd 여야 한다",
  );
  // Erasing the null possibility with a cast makes type checking miss the dereference — one defect actually got
  // through that way.
  assert.equal(
    source.includes("as ChildProcessWithoutNullStreams"),
    false,
    "spawn 결과를 non-null 스트림 타입으로 캐스트하면 안 된다",
  );
  assert.match(source, /let child: ChildProcess;/);
  assert.match(source, /child\.stdout\?\.on\(/, "stdout 은 null 일 수 있다");
  assert.match(source, /child\.stderr\?\.on\(/, "stderr 은 null 일 수 있다");
});

// --- Temporary stdio is protected per dedicated directory, not per file ---

test("secureStdioDir: win32 applies the ACL once to an empty directory", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "deskrpg-acl-test-"));
  const calls: string[] = [];
  const result = secureStdioDir(
    "win32",
    () => dir,
    (d) => {
      calls.push(d);
      // The directory must be empty when permissions are narrowed — a token file must not exist first.
      assert.deepEqual(readdirSync(d), []);
    },
    () => NARROWED,
  );
  assert.equal(result, dir);
  assert.deepEqual(calls, [dir], "디렉터리에 정확히 한 번");
  rmSync(dir, { recursive: true, force: true });
});

test("secureStdioDir: ACL failure is fail-closed — throws and leaves no directory", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "deskrpg-acl-fail-"));
  assert.throws(() =>
    secureStdioDir(
      "win32",
      () => dir,
      () => {
        throw new Error("icacls_failed");
      },
    ),
  );
  assert.equal(existsSync(dir), false, "실패하면 디렉터리를 지운다");
});

test(
  "secureStdioDir: posix doesn't call icacls and narrows to 0700",
  { skip: process.platform === "win32" ? "POSIX file modes" : false },
  () => {
    let hardened = false;
    const dir = secureStdioDir(
      "linux",
      () => mkdtempSync(path.join(os.tmpdir(), "deskrpg-acl-posix-")),
      () => {
        hardened = true;
      },
    );
    assert.equal(hardened, false);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    rmSync(dir, { recursive: true, force: true });
  },
);

test("executor source: neither per-file icacls nor per-file deletion remains", () => {
  const source = readFileSync(new URL("./executor.ts", import.meta.url), "utf-8");
  const icacls = source.match(/execFileSync\(\s*"icacls",\s*\[[^\]]*\]/g) ?? [];
  // Grant, remove inheritance, read back — every call targets the directory, never a file.
  assert.equal(icacls.length, 3, icacls.join("\n"));
  for (const call of icacls) {
    assert.match(call, /\[dir(,|\])/, "icacls 대상은 디렉터리여야 한다");
    assert.ok(
      !/stdinFile|stdoutFile/.test(call),
      "stdin/stdout 파일에 직접 icacls 를 걸면 안 된다",
    );
  }
  // Without (OI)(CI) only the directory is narrowed, and token files inside inherit SYSTEM/Administrators.
  assert.ok(
    icacls.some((call) => /:\(OI\)\(CI\)F/.test(call)),
    "파일로 상속되려면 (OI)(CI) 를 명시해야 한다",
  );
  assert.equal(source.includes("unlinkSync"), false, "파일 단위 삭제가 남아 있으면 안 된다");
});

test("executor source: cleanup is done once, for the whole directory, via removeStdioDir", () => {
  const source = readFileSync(new URL("./executor.ts", import.meta.url), "utf-8");
  const body = source.slice(source.indexOf("export function createExecutor"));
  const removals = body.match(/rmSync\(/g) ?? [];
  assert.equal(removals.length, 1, "createExecutor 안의 rmSync 는 removeStdioDir 하나뿐");
  assert.match(
    body,
    /const removeStdioDir = \(\): boolean => \{[\s\S]*?rmSync\(stdioDir, \{ recursive: true, force: true \}\)/,
  );
  // finish() is the only termination path, and deletion happens inside it — independent of listener
  // registration order.
  const finish = body.slice(body.indexOf("const finish ="), body.indexOf("const abort ="));
  assert.ok(finish.includes("removeStdioDir()"), "finish() 안에서 정리해야 한다");
});

test("executor source: the error path deletes temp files after killing the child", () => {
  // On timeout, cancel, or output_limit, ssh.exe is still alive holding the stdin.in and stdout.out handles.
  // Trying to delete first fails with a sharing violation on Windows, leaving the token-bearing payload in %TEMP%.
  const source = readFileSync(new URL("./executor.ts", import.meta.url), "utf-8");
  const body = source.slice(source.indexOf("export function createExecutor"));
  const finish = body.slice(body.indexOf("const finish ="), body.indexOf("const abort ="));
  const errorBranch = finish.slice(finish.indexOf("if (error) {"));
  const kill = errorBranch.indexOf("killProcessTree(");
  const cleanup = errorBranch.indexOf("removeStdioDir()");
  assert.ok(kill >= 0 && cleanup >= 0, "오류 경로에 kill 과 정리가 둘 다 있어야 한다");
  assert.ok(kill < cleanup, "정리는 killProcessTree 뒤여야 한다");
  assert.ok(cleanup < errorBranch.indexOf("reject("), "정리는 reject 전에 시도해야 한다");
  // The child takes time to die, so if the first attempt fails it retries one tick later.
  assert.match(
    errorBranch,
    /if \(!removeStdioDir\(\)\) setTimeout\(removeStdioDir, 0\)\.unref\(\)/,
  );
  // On the success path the child is already dead, so it just deletes once.
  const successBranch = finish.slice(finish.indexOf("} else {"));
  assert.match(successBranch, /removeStdioDir\(\);\s*resolve\(/);
});

// `icacls <dir>` right after hardening. The runner shape is what windows-latest left in CI: the
// grant went through but the inherited %TEMP% entries stayed, so files inside inherited them.
const NARROWED =
  "C:\\Users\\USER\\AppData\\Local\\Temp\\deskrpg-ssh-WrQiz2 WINSERVER\\USER:(OI)(CI)(F)\r\n" +
  "\r\nSuccessfully processed 1 files; Failed processing 0 files\r\n";
const STILL_INHERITED =
  "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\deskrpg-ssh-neVrgl runnervm99s1a\\runneradmin:(OI)(CI)(F)\r\n" +
  "                                                     NT AUTHORITY\\SYSTEM:(I)(OI)(CI)(F)\r\n" +
  "                                                     BUILTIN\\Administrators:(I)(OI)(CI)(F)\r\n" +
  "                                                     runnervm99s1a\\runneradmin:(I)(OI)(CI)(F)\r\n" +
  "\r\nSuccessfully processed 1 files; Failed processing 0 files\r\n";

test("isOwnerOnlyAcl: one explicit entry is narrowed; inherited entries are not", () => {
  assert.equal(isOwnerOnlyAcl(NARROWED), true);
  assert.equal(isOwnerOnlyAcl(STILL_INHERITED), false);
  assert.equal(isOwnerOnlyAcl("Successfully processed 0 files"), false, "no entry at all");
});

test("secureStdioDir: a directory icacls did not really narrow is fail-closed", () => {
  let made = "";
  assert.throws(
    () =>
      secureStdioDir(
        "win32",
        () => (made = mkdtempSync(path.join(os.tmpdir(), "deskrpg-acl-"))),
        () => {},
        () => STILL_INHERITED,
      ),
    /acl_not_narrowed/,
  );
  assert.equal(existsSync(made), false, "the unprotected directory was left behind");
});
