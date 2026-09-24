import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createSystemSsh,
  parseSshConfigHosts,
  readSshConfigHosts,
  systemSshArgs,
  systemSshAvailable,
  validateSystemTarget,
} from "./system-ssh";

function tempHome() {
  return mkdtempSync(path.join(os.tmpdir(), "deskrpg-sysssh-"));
}

test("config aliases — drops wildcard/negated patterns and keeps order", () => {
  assert.deepEqual(
    parseSshConfigHosts("Host my-server nas\n  User deploy\nHost *\nhost !bad web-1 *.x\n"),
    ["my-server", "nas", "web-1"],
  );
});

test("follows Include to collect aliases (relative paths, trailing *)", () => {
  const home = tempHome();
  try {
    mkdirSync(path.join(home, ".ssh", "conf.d"), { recursive: true });
    writeFileSync(path.join(home, ".ssh", "config"), "Include conf.d/*.conf\nHost main\n");
    writeFileSync(path.join(home, ".ssh", "conf.d", "a.conf"), "Host inc-a\n");
    writeFileSync(path.join(home, ".ssh", "conf.d", "skip.txt"), "Host no\n");
    assert.deepEqual(readSshConfigHosts(home), ["main", "inc-a"]);
    assert.equal(systemSshAvailable(home), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the Desktop method hides when ~/.ssh is missing (container)", () => {
  const home = tempHome();
  try {
    assert.equal(systemSshAvailable(home), false);
    assert.deepEqual(readSshConfigHosts(home), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("target validation — rejects option injection, control characters and metadata addresses; key file must exist", () => {
  const home = tempHome();
  try {
    mkdirSync(path.join(home, ".ssh"));
    writeFileSync(path.join(home, ".ssh", "id_ed25519"), "x");
    assert.deepEqual(
      validateSystemTarget(
        { target: "my-server", user: "deploy", port: "2222", keyPath: "~/.ssh/id_ed25519" },
        home,
      ),
      {
        target: "my-server",
        user: "deploy",
        port: 2222,
        keyPath: path.join(home, ".ssh", "id_ed25519"),
      },
    );
    for (const bad of [
      { target: "-oProxyCommand=x" },
      { target: "a b" },
      { target: "169.254.169.254" },
      { target: "ok", user: "Root;" },
      { target: "ok", port: "99999" },
      { target: "ok", keyPath: "-i/x" },
      { target: "ok", keyPath: "relative/key" },
    ])
      assert.throws(
        () => validateSystemTarget(bad, home),
        /setup_invalid_request/,
        JSON.stringify(bad),
      );
    assert.throws(
      () => validateSystemTarget({ target: "ok", keyPath: "~/.ssh/missing" }, home),
      /ssh_key_not_found/,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("system host args carry only the selection without -F, and the list stays in a 0600 file", async () => {
  const home = tempHome();
  try {
    const store = createSystemSsh(home);
    const host = await store.add({ target: "my-server", port: 2222, user: "deploy" });
    assert.match(host.id, /^s-[a-f0-9]{10}$/);
    assert.equal(host.label, "deploy@my-server:2222");
    assert.deepEqual(systemSshArgs(host), ["-p", "2222", "-l", "deploy"]);
    assert.deepEqual(systemSshArgs({ ...host, port: undefined, user: undefined }), []);
    assert.equal(store.get(host.id)?.target, "my-server");
    assert.equal(statSync(path.join(home, "ssh", "system-hosts.json")).mode & 0o777, 0o600);
    await store.remove(host.id);
    assert.equal(store.list().length, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
