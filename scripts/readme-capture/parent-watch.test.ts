import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { processAlive, watchParent } from "./parent-watch";

test("processAlive treats only ESRCH as gone", () => {
  const throwing = (code: string) =>
    (() => {
      throw Object.assign(new Error(code), { code });
    }) as unknown as typeof process.kill;
  assert.equal(processAlive(1234, (() => true) as unknown as typeof process.kill), true);
  assert.equal(processAlive(1234, throwing("ESRCH")), false);
  assert.equal(processAlive(1234, throwing("EPERM")), true, "살아 있지만 신호 권한이 없는 경우");
});

test("watchParent reports a vanished parent exactly once", async () => {
  let alive = true;
  let calls = 0;
  const stop = watchParent(42, () => calls++, { intervalMs: 5, isAlive: () => alive });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 0);
  alive = false;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls, 1);
  stop();
});

// When the test runner is cut off by SIGKILL or Ctrl-C, neither `t.after` nor `finally` runs. Check with the real launcher
// whether the capture server then ends on its own — SIGKILL the parent to deliberately skip the cleanup path.
//
// The app is a stand-in that just stays alive (`dev-server.ts`) instead of Next. Watching starts before the launcher loads the app,
// so that is enough, and a loaded full run does not wait for Next to boot (tens of seconds).
test(
  "the capture server stops itself when its parent is killed without cleanup",
  { timeout: 60_000 },
  async (t) => {
    const sourceRoot = path.resolve(import.meta.dirname, "../..");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "deskrpg-parent-watch-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const marker = path.join(root, "app-started");
    fs.writeFileSync(
      path.join(root, "dev-server.ts"),
      `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(marker)}, String(process.pid));\nsetInterval(() => {}, 1_000);\n`,
    );

    // Middle parent: starts the launcher, reports its pid, then stays idle. This is the process we SIGKILL.
    const launcher = path.join(sourceRoot, "scripts/readme-capture/server-launcher.ts");
    const parentScript = `
      const { spawn } = require("node:child_process");
      const child = spawn(process.execPath, ["--import", "tsx", ${JSON.stringify(launcher)}], {
        cwd: ${JSON.stringify(sourceRoot)}, detached: true, stdio: "ignore",
        env: { PATH: process.env.PATH, DESKRPG_CAPTURE_MODE: "1",
          DESKRPG_PROJECT_ROOT: ${JSON.stringify(root)}, DESKRPG_CAPTURE_PARENT_PID: String(process.pid) },
      });
      child.unref();
      process.stdout.write(String(child.pid) + "\\n");
      setInterval(() => {}, 1000);
    `;
    const parent = spawn(process.execPath, ["-e", parentScript], {
      stdio: ["ignore", "pipe", "inherit"],
      env: { PATH: process.env.PATH, NODE_ENV: "test" },
    });
    // However this test ends, leave neither behind. A live child blocks this file from ending
    // and halts the whole runner — keep the test from recreating the very defect it fixes.
    let launcherPid = 0;
    t.after(() => {
      parent.kill("SIGKILL");
      if (launcherPid)
        try {
          process.kill(-launcherPid, "SIGKILL");
        } catch {}
    });
    launcherPid = await new Promise<number>((resolve, reject) => {
      parent.stdout?.once("data", (chunk) => resolve(Number(String(chunk).trim())));
      parent.once("exit", () => reject(new Error("intermediate parent exited early")));
    });

    const started = Date.now() + 30_000;
    while (!fs.existsSync(marker) && Date.now() < started)
      await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(fs.existsSync(marker), "launcher never loaded the app");

    parent.kill("SIGKILL");
    const gone = Date.now() + 15_000;
    while (processAlive(launcherPid) && Date.now() < gone)
      await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(processAlive(launcherPid), false, "런처가 부모 없이 살아남았다");
  },
);
