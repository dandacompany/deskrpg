import {
  spawn,
  execFileSync,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  type StdioOptions,
} from "node:child_process";
import { openSync, closeSync, readFileSync, writeFileSync, rmSync, fstatSync } from "node:fs";
import { chmodSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { tmpdir, userInfo } from "node:os";
import { managedSsh } from "./ssh-hosts";
import { systemSsh, systemSshArgs } from "./system-ssh";
import { isWindows } from "./platform";
import type { HostExecutor } from "./types";

export const SSH_OPTIONS = [
  "-o",
  "BatchMode=yes",
  "-o",
  "StrictHostKeyChecking=yes",
  "-o",
  "ConnectTimeout=10",
  "-o",
  "ServerAliveInterval=15",
  "-o",
  "ServerAliveCountMax=2",
  "-o",
  "ControlMaster=no",
  "-o",
  "ControlPath=none",
];
const ALIAS = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
/**
 * Hosts reachable over SSH: hosts the admin registered on screen (managed SSH, dedicated key) + server
 * `~/.ssh/config` aliases the operator approved via environment variable (legacy method, for compatibility).
 */
export function getSshHosts(): { id: string; label: string; kind?: "system" | "managed" }[] {
  const managed = [
    ...systemSsh()
      .list()
      .map((h) => ({ id: h.id, label: h.label, kind: "system" as const })),
    ...managedSsh()
      .list()
      .map((h) => ({ id: h.id, label: h.label, kind: "managed" as const })),
  ];
  const legacy = [
    ...new Set(
      (process.env.DESKRPG_SETUP_SSH_HOSTS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => ALIAS.test(s)),
    ),
  ]
    .filter((id) => !managed.some((h) => h.id === id))
    .map((id) => ({ id, label: id }));
  return [...managed, ...legacy];
}
/** For a managed host, points at the managed ssh config (`-F`). Legacy aliases use the server ssh config as-is. */
export function sshConfigArgs(hostId: string): string[] {
  return managedSsh().configArgs(hostId);
}
/**
 * How to invoke one host over ssh — leading args, host key policy, destination.
 * - System host (Desktop style): server user config as-is + `-p/-l/-i`, `accept-new`, destination is alias/hostname.
 * - Dedicated-key host: `-F <managed config>`, pinned fingerprint (`yes`), destination is the managed alias.
 * - Legacy env-var alias: server config as-is, `yes`.
 */
export function sshRoute(hostId: string): { args: string[]; options: string[]; dest: string } {
  const system = hostId.startsWith("s-") ? systemSsh().get(hostId) : undefined;
  if (system)
    return {
      args: systemSshArgs(system),
      options: sshOptions("accept-new"),
      dest: system.target,
    };
  return { args: sshConfigArgs(hostId), options: SSH_OPTIONS, dest: hostId };
}
export function sshOptions(hostKey: "yes" | "accept-new"): string[] {
  return SSH_OPTIONS.map((o) =>
    o === "StrictHostKeyChecking=yes" ? `StrictHostKeyChecking=${hostKey}` : o,
  );
}
export function assertSshHost(hostId: string) {
  if (!ALIAS.test(hostId) || !getSshHosts().some((h) => h.id === hostId))
    throw new Error("ssh_unknown_host");
}
export function quoteShellArg(value: string) {
  if (value.includes("\0")) throw new Error("setup_invalid_request");
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/**
 * Kills the child and its grandchildren too. Install scripts spawn more children, so killing only direct ones leaves
 * some.
 *
 * POSIX kills the whole process group (created by `spawn` with `detached: true`).
 * Windows has no process-group signal, so the tree is cut with `taskkill /T`. A cleanup failure must not change
 * the error path, so if taskkill is missing or fails we at least kill the direct child and move on.
 */
export function killProcessTree(
  pid: number,
  platform: string,
  kill: (pid: number, signal: string) => void,
  run: (command: string, args: string[]) => void,
): void {
  if (isWindows(platform)) {
    try {
      run("taskkill", ["/PID", String(pid), "/T", "/F"]);
    } catch {
      try {
        kill(pid, "SIGKILL");
      } catch {
        // Already dead.
      }
    }
    return;
  }
  kill(-pid, "SIGKILL");
}

/**
 * Whether `icacls <dir>` output shows exactly one access entry and it is not inherited — the state
 * `/grant:r <user>` plus `/inheritance:r` must leave. Only the entry shape is read, not the name:
 * icacls prints names in the console code page, and the grant target is ours anyway.
 */
export function isOwnerOnlyAcl(icaclsOutput: string): boolean {
  const entries = icaclsOutput
    .split(/\r?\n/)
    .filter((line) => line.includes(":("))
    // An integrity label (`Mandatory Label\High Mandatory Level:(NW)`) is not an access entry;
    // an elevated process may get one on what it creates.
    .filter((line) => !/Mandatory Label\\|\((NW|NR|NX)\)/i.test(line));
  return entries.length === 1 && !entries[0].includes("(I)");
}

/** Narrows with icacls: grant the user with inheritance to children, then drop inherited entries. */
export function icaclsHarden(dir: string): void {
  execFileSync("icacls", [dir, "/grant:r", `${userInfo().username}:(OI)(CI)F`], {
    stdio: "ignore",
  });
  execFileSync("icacls", [dir, "/inheritance:r"], { stdio: "ignore" });
}

/**
 * Narrows through .NET instead: a fresh, protected DACL holding only the current user's SID, inherited
 * by files and folders inside. The path travels in the environment, so no quoting is involved.
 */
const SET_ACL_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$item = Get-Item -LiteralPath $env:DESKRPG_ACL_DIR",
  "$acl = New-Object System.Security.AccessControl.DirectorySecurity",
  "$acl.SetAccessRuleProtection($true, $false)",
  "$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User",
  "$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($user, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')",
  "$acl.AddAccessRule($rule)",
  "$item.SetAccessControl($acl)",
].join("; ");

export function setAclHarden(dir: string): void {
  execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", SET_ACL_SCRIPT], {
    stdio: "ignore",
    env: { ...process.env, DESKRPG_ACL_DIR: dir },
  });
}

/**
 * Creates a **dedicated directory** for the temporary stdin/stdout files used by the Windows ssh branch, and
 * narrows its permissions while it is still empty. The files hold gateway/profile tokens in plaintext, so narrowing
 * after the files exist would expose them in the meantime via ACLs inherited from `%TEMP%` (including group Modify).
 *
 * Windows: `icacls <dir> /inheritance:r /grant:r <user>:(OI)(CI)F`. **`(OI)(CI)` must be explicit for
 * files newly created inside to inherit this ACL** — icacls does not add inheritance flags by default
 * just because it is a directory. Giving only `<user>:F` narrows the directory itself, but files inside
 * inherit SYSTEM·BUILTIN\Administrators and are exposed to the group (measured 2026-09-20 on WinServer:
 * `:F` gives files SYSTEM·Administrators·S-1-5-5-*, `:(OI)(CI)F` gives the user alone with inherited=True).
 * Node's `chmodSync` only touches the read-only attribute on Windows and is ineffective, so it is not used.
 * On failure it throws and aborts the operation (fail-closed) — tokens are never written without narrowed permissions.
 *
 * Every attempt is read back. On the windows-latest runner (Windows Server 2025, CI 2026-09-26)
 * `icacls /inheritance:r` exited 0 but kept SYSTEM, Administrators and the user as **explicit**
 * `(OI)(CI)(F)` entries — it behaved like `/inheritance:d` (copy), so files inside still granted
 * SYSTEM and Administrators. A success code alone proves nothing. icacls goes first (it narrows on
 * other hosts, WinServer included), then a .NET DACL (`setAclHarden`), which narrowed on the runner;
 * if neither leaves a narrowed ACL the directory is removed and the call fails.
 */
export function secureStdioDir(
  platform: string,
  make: () => string = () => mkdtempSync(path.join(tmpdir(), "deskrpg-ssh-")),
  hardeners: Array<(dir: string) => void> = [icaclsHarden, setAclHarden],
  readAcl: (dir: string) => string = (dir) => execFileSync("icacls", [dir], { encoding: "utf8" }),
): string {
  const dir = make();
  try {
    if (isWindows(platform)) {
      let narrowed = false;
      for (const harden of hardeners) {
        try {
          harden(dir);
        } catch {
          // The next way may still work; the read-back below is what decides.
        }
        if (isOwnerOnlyAcl(readAcl(dir))) {
          narrowed = true;
          break;
        }
      }
      if (!narrowed) throw new Error("acl_not_narrowed");
    } else chmodSync(dir, 0o700);
  } catch (error) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A cleanup failure must not defeat fail-closed.
    }
    throw error;
  }
  return dir;
}

export type SpawnCommand = (
  command: string,
  args: string[],
  /** Values layered on the parent env. Only for payloads that cannot go in argv (Windows PowerShell launcher). */
  env?: Record<string, string>,
) => ChildProcessWithoutNullStreams;
const spawnCommand: SpawnCommand = (command, args, env) =>
  spawn(command, args, {
    stdio: "pipe",
    shell: false,
    detached: process.platform !== "win32",
    // With nothing to pass, omit the field entirely — leave node's default behavior (inherit the parent env) intact.
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
/** Only server-authored commands may reach this adapter. Input carries helper payloads/secrets outside argv. */
export function createExecutor(spawnImpl: SpawnCommand = spawnCommand): HostExecutor {
  return async (command, args, options = {}) => {
    if (
      !/^[A-Za-z0-9_./-]+$/.test(command) ||
      command.startsWith("-") ||
      args.some((a) => a.includes("\0"))
    )
      throw new Error("setup_invalid_request");
    if (options.signal?.aborted) throw new Error("setup_cancelled");
    return new Promise((resolve, reject) => {
      // Windows ssh stalls on stdout/stdin pipes, so we use temp files instead.
      const useFileStdio = isWindows(process.platform) && command === "ssh";
      let stdioDir: string | undefined;
      let stdinFile: string | undefined;
      let stdinFd: number | undefined;
      let stdoutFile: string | undefined;
      let stdoutFd: number | undefined;
      /**
       * Temp-file cleanup removes the whole directory. Safe to call twice; returns `false` on failure.
       * On Windows, if the child is still alive and holding the `stdin.in`·`stdout.out` handles, deletion
       * fails with a sharing violation, so `stdioDir` is not cleared until deletion succeeds and retries handle it.
       */
      const removeStdioDir = (): boolean => {
        if (!stdioDir) return true;
        try {
          rmSync(stdioDir, { recursive: true, force: true });
          stdioDir = undefined;
          return true;
        } catch {
          // A delete failure does not change the error path. The caller retries after kill.
          return false;
        }
      };

      if (useFileStdio) {
        try {
          // These files carry tokens, so narrow permissions on the empty dedicated directory **before** creating files.
          // Narrowing per file would only take effect after the payload is written / the child starts writing,
          // leaving a gap.
          stdioDir = secureStdioDir(process.platform);
          if (options.input) {
            stdinFile = path.join(stdioDir, "stdin.in");
            writeFileSync(stdinFile, options.input);
            stdinFd = openSync(stdinFile, "r");
          }
          stdoutFile = path.join(stdioDir, "stdout.out");
          stdoutFd = openSync(stdoutFile, "w");
        } catch {
          if (stdinFd !== undefined) closeSync(stdinFd);
          if (stdoutFd !== undefined) closeSync(stdoutFd);
          removeStdioDir();
          reject(new Error("command_failed"));
          return;
        }
      }

      // In the file branch, stdin (file fd)·stdout (file fd) are `null`, not pipes.
      // Casting to `ChildProcessWithoutNullStreams` erases that null possibility from the type and
      // the checks miss the dereference — this work actually let one defect through that way.
      let child: ChildProcess;
      try {
        if (useFileStdio && stdoutFd !== undefined) {
          const stdio: StdioOptions = [stdinFd !== undefined ? stdinFd : "pipe", stdoutFd, "pipe"];
          child = spawn(command, args, {
            stdio,
            shell: false,
            detached: process.platform !== "win32",
            ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
          });
        } else {
          child = spawnImpl(command, args, options.env);
        }
      } catch {
        if (stdinFd !== undefined) closeSync(stdinFd);
        if (stdoutFd !== undefined) closeSync(stdoutFd);
        removeStdioDir();
        reject(new Error("command_failed"));
        return;
      }
      let stdout = "",
        stderr = "",
        bytes = 0,
        settled = false;
      const finish = (error?: string, code = 1) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);

        // Read stdout from the file
        if (useFileStdio && stdoutFile) {
          try {
            if (stdoutFd !== undefined) {
              // File size cap check (matches output_limit)
              const stat = fstatSync(stdoutFd);
              // Do not overwrite an earlier error (command_timeout etc.) — it would swap the cause the user sees.
              if (!error && stat.size > 1024 * 1024) {
                error = "output_limit";
              }
              closeSync(stdoutFd);
              stdoutFd = undefined;
            }
            if (!error) {
              stdout = readFileSync(stdoutFile, "utf-8");
            }
          } catch {
            // Keep going even if reading the file fails
          }
        }
        if (useFileStdio && stdinFd !== undefined) {
          try {
            closeSync(stdinFd);
          } catch {
            // Ignore close failure
          }
          stdinFd = undefined;
        }
        // finish() is the single termination path and the try/catch below funnels even sync exceptions here,
        // so cleanup is **attempted** regardless of listener registration order. Success is not guaranteed — if the
        // child is alive and holding handles, deletion fails on Windows. So on the error path we
        // kill the child first and delete afterwards.
        if (error) {
          // Include helper-owned installers, not just their parent Python process.
          try {
            if (child.pid)
              killProcessTree(
                child.pid,
                process.platform,
                (pid, signal) => process.kill(pid, signal as NodeJS.Signals),
                (command, args) => execFileSync(command, args, { stdio: "ignore" }),
              );
            else child.kill("SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
          // The child takes time to die, so if it fails now, try once more a tick later.
          // Otherwise the payload carrying gateway/profile tokens is left in %TEMP%.
          if (!removeStdioDir()) setTimeout(removeStdioDir, 0).unref();
          reject(new Error(error));
        } else {
          removeStdioDir();
          resolve({ stdout, stderr, code });
        }
      };
      const abort = () => finish("setup_cancelled");
      const timer = setTimeout(
        () => finish("command_timeout"),
        Math.max(1, Math.min(options.timeoutMs ?? 30_000, 600_000)),
      );
      const collect = (value: Buffer, stream: "stdout" | "stderr") => {
        bytes += value.length;
        if (bytes > 1024 * 1024) {
          finish("output_limit");
          return;
        }
        if (stream === "stdout") stdout += value.toString();
        else stderr += value.toString();
      };
      try {
        // With useFileStdio, stdout goes to a file, so no listener is needed
        if (!useFileStdio) {
          child.stdout?.on("data", (data) => collect(data, "stdout"));
        }
        child.stderr?.on("data", (data) => collect(data, "stderr"));
        child.on("error", () => finish("command_failed"));
        child.on("close", (code) => finish(undefined, code ?? 1));
        // When stdin is a file fd, Node leaves child.stdin as null
        if (child.stdin) {
          child.stdin.on("error", () => {
            /* early exit is handled by close */
          });
        }
        options.signal?.addEventListener("abort", abort, { once: true });
        if (options.signal?.aborted) abort();
        // When stdin is a file it is already read from the file, so end() is not called
        if (child.stdin) {
          if (useFileStdio && stdinFd !== undefined) {
            child.stdin.end();
          } else {
            child.stdin.end(options.input);
          }
        }
      } catch {
        // Even if a sync exception occurs during listener registration, finish() removes the temp directory.
        finish("command_failed");
      }
    });
  };
}
export const localExecutor = createExecutor();

/**
 * Windows' ssh.exe (Win32-OpenSSH 9.5p2, the inbox client) stops delivering stdout after two 32 KiB
 * channel packets: up to 65536 bytes it exits normally, up to 98304 it delivers everything but never
 * exits, and past that it stalls at 98304. The stdout being a file fd, a cmd.exe redirect or a pipe
 * makes no difference (a pipe stalls sooner), and the same remote output arrives whole through macOS
 * ssh and through Windows scp — so the limit is ssh.exe's, and replies must stay within it.
 */
export const WINDOWS_SSH_STDOUT_LIMIT = 65536;

export function sshStdoutLimit(platform: string): number | undefined {
  return isWindows(platform) ? WINDOWS_SSH_STDOUT_LIMIT : undefined;
}

/** The ssh route's leading args in scp's spelling: scp takes the port as `-P` and has no `-l`. */
export function scpArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "-p") out.push("-P", args[++i]);
    else if (args[i] === "-l") out.push("-o", `User=${args[++i]}`);
    else out.push(args[i]);
  }
  return out;
}

/** `host:path` for scp. A Windows path is given as `/C:/...`, the form Win32-OpenSSH's sftp server expects. */
export function scpSource(dest: string, remotePath: string): string {
  const windows = /^[A-Za-z]:\\/.test(remotePath);
  return `${dest}:${windows ? "/" + remotePath.replace(/\\/g, "/") : remotePath}`;
}

export function sshExecutor(
  hostId: string,
  execute: HostExecutor = localExecutor,
  /** Where DeskRPG itself runs — only a Windows client has the stdout cap and fetches files. */
  clientPlatform: string = process.platform,
): HostExecutor {
  assertSshHost(hostId);
  const limit = sshStdoutLimit(clientPlatform);
  const run: HostExecutor = async (command, args, options) => {
    assertSshHost(hostId);
    if (!/^[A-Za-z0-9_./-]+$/.test(command) || command.startsWith("-"))
      throw new Error("setup_invalid_request");
    const route = sshRoute(hostId);
    const result = await execute(
      "ssh",
      [
        ...route.args,
        ...route.options,
        "-T",
        "--",
        route.dest,
        [command, ...args].map(quoteShellArg).join(" "),
      ],
      options,
    );
    // OpenSSH stderr may contain remote banners, paths or secrets. Never propagate it on transport failures.
    if (result.code === 255) throw new Error(sshFailureCode(result.stderr));
    return result;
  };
  if (limit !== undefined) {
    run.stdoutLimit = limit;
    // scp.exe delivers what ssh.exe cannot (measured: the same reply arrives whole through scp).
    run.fetchFile = async (remotePath, localPath, options) => {
      assertSshHost(hostId);
      const route = sshRoute(hostId);
      const result = await execute(
        "scp",
        [
          ...scpArgs(route.args),
          ...route.options,
          "-q",
          "--",
          scpSource(route.dest, remotePath),
          localPath,
        ],
        options,
      );
      // Like ssh, scp's stderr is never passed on.
      if (result.code !== 0) throw new Error("host_operation_failed");
    };
  }
  return run;
}

/** stderr of ssh exit code 255 → a safe error code. Raw stderr may contain banners/paths, so it is not passed on. */
export function sshFailureCode(stderr: string): string {
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(stderr))
    return "ssh_host_key_failed";
  // Reached the host but the key was rejected — usually the public key is not in authorized_keys yet.
  // Lumping it into "connection failed" makes people suspect the server/port (measured on staging 2026-09-19).
  if (/Permission denied \(publickey/i.test(stderr)) return "ssh_auth_failed";
  return "ssh_connection_failed";
}
