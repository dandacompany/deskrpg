import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Set before import so the singleton picks up this temp home (each file runs in its own process).
const home = mkdtempSync(path.join(os.tmpdir(), "deskrpg-exec-sys-"));
process.env.DESKRPG_HOME = home;
delete process.env.DESKRPG_SETUP_SSH_HOSTS;
test.after(() => rmSync(home, { recursive: true, force: true }));

test("a system host is called with the destination as an alias, without -F, and host key accept-new", async () => {
  const { systemSsh } = await import("./system-ssh");
  const { getSshHosts, sshExecutor } = await import("./executor");
  const host = await systemSsh().add({ target: "my-server", user: "deploy" });
  assert.deepEqual(getSshHosts(), [{ id: host.id, label: "deploy@my-server", kind: "system" }]);
  let recorded: string[] = [];
  await sshExecutor(host.id, async (_command, args) => {
    recorded = args;
    return { stdout: "", stderr: "", code: 0 };
  })("true", []);
  assert.ok(!recorded.includes("-F"));
  assert.ok(recorded.includes("StrictHostKeyChecking=accept-new"));
  assert.ok(!recorded.includes("StrictHostKeyChecking=yes"));
  assert.deepEqual(recorded.slice(0, 2), ["-l", "deploy"]);
  assert.equal(recorded[recorded.indexOf("--") + 1], "my-server");
});

test("a key rejection from a system host surfaces as ssh_auth_failed", async () => {
  const { systemSsh } = await import("./system-ssh");
  const { sshExecutor } = await import("./executor");
  const host = await systemSsh().add({ target: "nas" });
  const run = sshExecutor(host.id, async () => ({
    stdout: "",
    stderr: "deploy@nas: Permission denied (publickey).",
    code: 255,
  }));
  await assert.rejects(run("true", []), /^Error: ssh_auth_failed$/);
});
