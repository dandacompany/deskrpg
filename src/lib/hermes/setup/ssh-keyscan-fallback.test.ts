import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import test from "node:test";

import { createDefaultScan, parseKeyscan } from "./ssh-hosts";

// Windows' bundled OpenSSH (9.5, LibreSSL) offers the sntrup761 key exchange but cannot run it.
// Against a server that picks it (Ubuntu OpenSSH 9.6), ssh-keyscan prints
// "choose_kex: unsupported KEX method sntrup761x25519-sha512@openssh.com" and then stalls past
// its own -T until killed. ssh itself negotiates another method, so the key is read through it.

const ED = "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
const KEX_STALL =
  "# 10.0.0.5:22 SSH-2.0-OpenSSH_9.6p1 Ubuntu\nchoose_kex: unsupported KEX method sntrup761x25519-sha512@openssh.com\n";

type Call = { command: string; args: string[]; killed: boolean };

/** A spawn stand-in: each command gets a scripted behaviour, and every call is recorded. */
function fakeSpawn(script: Record<string, (child: FakeChild, args: string[]) => void>) {
  const calls: Call[] = [];
  const spawn = (command: string, args: string[]) => {
    const call: Call = { command, args, killed: false };
    calls.push(call);
    const child = new FakeChild(() => (call.killed = true));
    setImmediate(() => script[command]?.(child, args));
    return child;
  };
  return { spawn: spawn as never, calls };
}

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  constructor(private readonly onKill: () => void) {
    super();
  }
  kill() {
    this.onKill();
    setImmediate(() => this.emit("close", null, "SIGKILL"));
    return true;
  }
  exit(code: number) {
    this.emit("close", code, null);
  }
}

const target = { host: "10.0.0.5", port: 22, user: "dante" };

test("keyscan output is used as-is when it returns keys", async () => {
  const { spawn, calls } = fakeSpawn({
    "ssh-keyscan": (child) => {
      child.stdout.write(`10.0.0.5 ssh-ed25519 ${ED}\n`);
      child.exit(0);
    },
  });
  const out = await createDefaultScan({ spawn })(target);
  assert.equal(parseKeyscan(out).length, 1);
  assert.deepEqual(
    calls.map((c) => c.command),
    ["ssh-keyscan"],
  );
});

test("a keyscan stalled on an unsupported key exchange is cut at once and the key is read through ssh", async () => {
  let knownHosts = "";
  const { spawn, calls } = fakeSpawn({
    "ssh-keyscan": (child) => child.stderr.write(KEX_STALL), // and never exits
    ssh: (_child, args) => {
      const option = args.find((a) => a.startsWith("UserKnownHostsFile="))!;
      knownHosts = option.slice("UserKnownHostsFile=".length);
      // ssh records the key before authentication, then hangs on Windows after the auth failure.
      writeFileSync(knownHosts, `10.0.0.5 ssh-ed25519 ${ED}\n`);
    },
  });
  const started = Date.now();

  const out = await createDefaultScan({ spawn, timeoutMs: 10_000 })(target);

  assert.ok(Date.now() - started < 2_000, "neither stall waits for a timeout");
  assert.deepEqual(
    parseKeyscan(out).map((k) => k.blob),
    [ED],
  );
  assert.deepEqual(
    calls.map((c) => [c.command, c.killed]),
    [
      ["ssh-keyscan", true],
      ["ssh", true],
    ],
  );
  const args = calls[1].args;
  for (const option of [
    "StrictHostKeyChecking=accept-new",
    "BatchMode=yes",
    "PreferredAuthentications=none",
  ]) {
    assert.ok(args.includes(option), option);
  }
  assert.equal(existsSync(knownHosts), false, "the throwaway known_hosts is removed");
});

test("a keyscan that never answers ends at the outer limit as a connection failure", async () => {
  const { spawn, calls } = fakeSpawn({ "ssh-keyscan": () => {} });
  await assert.rejects(
    createDefaultScan({ spawn, timeoutMs: 50 })(target),
    /ssh_connection_failed/,
  );
  assert.equal(calls[0].killed, true);
});

test("the ssh fallback that records no key is a connection failure", async () => {
  const { spawn } = fakeSpawn({
    "ssh-keyscan": (child) => child.stderr.write(KEX_STALL),
    ssh: (child) => child.exit(255),
  });
  await assert.rejects(
    createDefaultScan({ spawn, timeoutMs: 2_000 })(target),
    /ssh_connection_failed/,
  );
});

test("Windows gives keyscan three seconds so the fallback still lands within five", async () => {
  const seen: Record<string, string> = {};
  for (const platform of ["win32", "linux"]) {
    const { spawn, calls } = fakeSpawn({
      "ssh-keyscan": (child) => {
        child.stdout.write(`10.0.0.5 ssh-ed25519 ${ED}\n`);
        child.exit(0);
      },
    });
    await createDefaultScan({ spawn, platform })(target);
    seen[platform] = calls[0].args[calls[0].args.indexOf("-T") + 1];
  }
  assert.deepEqual(seen, { win32: "3", linux: "5" });
});
