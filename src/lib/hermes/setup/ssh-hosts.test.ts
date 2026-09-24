import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createManagedSsh,
  fingerprintOf,
  globalKnownHostsLine,
  parseKeyscan,
  validateSshTarget,
  type ScanFn,
} from "./ssh-hosts";

// A fixed value shaped like a public host key (not a real key — a base64 blob is enough for fingerprinting).
const ED = "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
const RSA = "AAAAB3NzaC1yc2EAAAADAQABAAABAQC7";

function dir() {
  return mkdtempSync(path.join(os.tmpdir(), "deskrpg-ssh-"));
}

function scanOf(lines: string): ScanFn {
  return async () => lines;
}

test("extracts key type and SHA256 fingerprint from keyscan output — drops comment lines", () => {
  const rows = parseKeyscan(
    `# box:22 SSH-2.0-OpenSSH\nbox ssh-ed25519 ${ED}\nbox ssh-rsa ${RSA}\n`,
  );
  assert.deepEqual(
    rows.map((r) => r.type),
    ["ssh-ed25519", "ssh-rsa"],
  );
  assert.equal(rows[0].fingerprint, fingerprintOf(ED));
  assert.match(rows[0].fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/);
});

test("validates target input — rejects option injection, whitespace and metadata addresses", () => {
  assert.deepEqual(validateSshTarget({ host: "minipc.local", port: 22, user: "dante" }), {
    host: "minipc.local",
    port: 22,
    user: "dante",
  });
  assert.deepEqual(validateSshTarget({ host: "10.0.0.5", port: "2222", user: "ubuntu" }), {
    host: "10.0.0.5",
    port: 2222,
    user: "ubuntu",
  });
  for (const bad of [
    { host: "-oProxyCommand=x", port: 22, user: "u" },
    { host: "a b", port: 22, user: "u" },
    { host: "a,b", port: 22, user: "u" },
    { host: "u@h", port: 22, user: "u" },
    { host: "169.254.169.254", port: 22, user: "u" },
    { host: "metadata.google.internal", port: 22, user: "u" },
    { host: "h", port: 0, user: "u" },
    { host: "h", port: 70000, user: "u" },
    { host: "h", port: 22, user: "-u" },
    { host: "h", port: 22, user: "Root User" },
  ]) {
    assert.throws(() => validateSshTarget(bad), /setup_invalid_request/, JSON.stringify(bad));
  }
});

test("creates the dedicated key once and returns the same public key on later calls", async () => {
  const home = dir();
  let generated = 0;
  const ssh = createManagedSsh(home, {
    keygen: async (keyPath) => {
      generated += 1;
      writeFileSync(keyPath, "PRIVATE", { mode: 0o600 });
      writeFileSync(`${keyPath}.pub`, "ssh-ed25519 AAAAPUB deskrpg@test\n");
    },
    scan: scanOf(""),
  });
  assert.equal(await ssh.publicKey(), "ssh-ed25519 AAAAPUB deskrpg@test");
  assert.equal(await ssh.publicKey(), "ssh-ed25519 AAAAPUB deskrpg@test");
  assert.equal(generated, 1);
  assert.equal(statSync(path.join(home, "ssh")).mode & 0o777, 0o700);
});

test("registers only when the confirmed and re-scanned fingerprints match, creating config and known_hosts", async () => {
  const home = dir();
  const ssh = createManagedSsh(home, {
    keygen: async (keyPath) => writeFileSync(keyPath, "K", { mode: 0o600 }),
    scan: scanOf(`box ssh-ed25519 ${ED}\n`),
  });
  const target = { host: "box", port: 2222, user: "dante" };
  const scanned = await ssh.scan(target);
  const host = await ssh.register(
    target,
    scanned.map((r) => r.fingerprint),
  );
  assert.match(host.id, /^h-[a-f0-9]{10}$/);
  assert.equal(host.label, "dante@box:2222");
  assert.deepEqual(
    ssh.list().map((h) => h.id),
    [host.id],
  );

  const config = readFileSync(ssh.configPath, "utf8");
  assert.match(config, new RegExp(`Host ${host.id}\\n`));
  assert.match(config, /HostName box\n/);
  assert.match(config, /Port 2222\n/);
  assert.match(config, /User dante\n/);
  assert.match(config, /IdentitiesOnly yes/);
  assert.match(config, /StrictHostKeyChecking yes/);
  assert.match(config, new RegExp(`HostKeyAlias ${host.id}`));
  const known = readFileSync(path.join(home, "ssh", "known_hosts"), "utf8");
  assert.equal(known, `${host.id} ssh-ed25519 ${ED}\n`);
  assert.equal(statSync(ssh.configPath).mode & 0o777, 0o600);
});

test("rejects when the host key changes between scan and registration", async () => {
  const home = dir();
  let lines = `box ssh-ed25519 ${ED}\n`;
  const ssh = createManagedSsh(home, {
    keygen: async (keyPath) => writeFileSync(keyPath, "K"),
    scan: async () => lines,
  });
  const target = { host: "box", port: 22, user: "dante" };
  const confirmed = (await ssh.scan(target)).map((r) => r.fingerprint);
  lines = `box ssh-rsa ${RSA}\n`;
  await assert.rejects(ssh.register(target, confirmed), /ssh_host_key_failed/);
  assert.deepEqual(ssh.list(), []);
});

test("removing a host removes only its line", async () => {
  const home = dir();
  const ssh = createManagedSsh(home, {
    keygen: async (keyPath) => writeFileSync(keyPath, "K"),
    scan: scanOf(`x ssh-ed25519 ${ED}\n`),
  });
  const a = await ssh.register({ host: "a", port: 22, user: "u" }, [fingerprintOf(ED)]);
  const b = await ssh.register({ host: "b", port: 22, user: "u" }, [fingerprintOf(ED)]);
  await ssh.remove(a.id);
  assert.deepEqual(
    ssh.list().map((h) => h.id),
    [b.id],
  );
  const known = readFileSync(path.join(home, "ssh", "known_hosts"), "utf8");
  assert.equal(known.includes(a.id), false);
  assert.equal(known.includes(b.id), true);
  assert.equal(readFileSync(ssh.configPath, "utf8").includes(a.id), false);
});

test("a managed host points -F at the managed config; an unknown alias gets no arguments", async () => {
  const home = dir();
  const ssh = createManagedSsh(home, {
    keygen: async (keyPath) => writeFileSync(keyPath, "K"),
    scan: scanOf(`x ssh-ed25519 ${ED}\n`),
  });
  const h = await ssh.register({ host: "a", port: 22, user: "u" }, [fingerprintOf(ED)]);
  assert.deepEqual(ssh.configArgs(h.id), ["-F", ssh.configPath]);
  assert.deepEqual(ssh.configArgs("legacy-alias"), []);
});

test("the null device in the managed config follows the platform", () => {
  assert.equal(globalKnownHostsLine("win32"), "  GlobalKnownHostsFile NUL");
  assert.equal(globalKnownHostsLine("linux"), "  GlobalKnownHostsFile /dev/null");
});
