import assert from "node:assert/strict";
import { spawn as spawnProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ChildProcess, SpawnOptions, spawn as nodeSpawn } from "node:child_process";

import {
  assertCaptureRuntimePath,
  createFixtureApi,
  runCaptureSession,
  terminateOwnedChild,
  persistFixture,
  captureStages,
  DEFAULT_CAPTURE_PORTS,
  type CapturePorts,
} from "./session";

/** A free set of ports per test. The same file running concurrently in another session does not collide. */
async function freePorts(): Promise<CapturePorts> {
  const take = async () => {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const { port } = probe.address() as { port: number };
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    return port;
  };
  return { app: await take(), internal: await take(), hermes: await take() };
}

test("real captures keep the README ports while tests inject their own", () => {
  assert.deepEqual(DEFAULT_CAPTURE_PORTS, { app: 3310, internal: 3311, hermes: 38642 });
});

test("capture development selects record only while the default retains all stages", () => {
  assert.deepEqual(captureStages(false), ["record", "media", "verify"]);
  assert.deepEqual(captureStages(true), ["record"]);
});

test("fixture manifest is atomically replaced before capture and has private permissions", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deskrpg-manifest-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixture = {
    loginId: "capture",
    password: "local",
    characterName: "Dante",
    channelId: "one",
    reportCardId: "card-one",
    npcNames: ["Sophie", "Noah"] as ["Sophie", "Noah"],
    profileNames: ["sophie", "noah"] as ["sophie", "noah"],
  };
  const target = persistFixture(root, fixture);
  persistFixture(root, { ...fixture, channelId: "two" });
  assert.equal(JSON.parse(fs.readFileSync(target, "utf8")).channelId, "two");
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ["fixture.json"]);
});

// The session signals the child's process group (-pid). A fake child's pid is a made-up number, so going through the real
// process.kill would signal whatever process group happens to use that number, and the fake would not die.
// So the session is always given `groupKill`, making the signal reach only this fake.
function runningChild(): {
  child: ChildProcess;
  groupKill: typeof process.kill;
  wasKilled(): boolean;
} {
  const child = new EventEmitter() as ChildProcess;
  let killed = false;
  const stop = (signal: NodeJS.Signals | number | undefined) => {
    killed = true;
    queueMicrotask(() => child.emit("exit", null, signal ?? "SIGTERM"));
    return true;
  };
  Object.assign(child, {
    pid: 44001,
    exitCode: null,
    signalCode: null,
    kill: stop,
  });
  const groupKill = ((pid: number, signal?: NodeJS.Signals | number) => {
    assert.equal(pid, -44001, "신호는 가짜 자식의 그룹으로만 가야 한다");
    return stop(signal);
  }) as typeof process.kill;
  return { child, groupKill, wasKilled: () => killed };
}

test("a failed health check terminates the DeskRPG child owned by the session", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deskrpg-session-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fake = runningChild();
  let spawnOptions: SpawnOptions | undefined;
  const spawn = ((_command: string, _args: readonly string[], options: SpawnOptions) => {
    spawnOptions = options;
    return fake.child;
  }) as typeof nodeSpawn;
  const unhealthyFetch = async () => new Response("unhealthy", { status: 503 });
  const ports = await freePorts();

  await assert.rejects(
    () =>
      runCaptureSession({
        root,
        spawn,
        fetch: unhealthyFetch as typeof fetch,
        ports,
        kill: fake.groupKill,
      }),
    /exited|health/i,
  );
  assert.equal(fake.wasKilled(), true);
  assert.equal(spawnOptions?.env?.DB_TYPE, "sqlite");
  assert.equal(
    spawnOptions?.env?.SQLITE_PATH,
    path.join(root, ".artifacts/readme-capture/runtime/data/db.sqlite"),
  );
  assert.equal(spawnOptions?.env?.DATABASE_URL, undefined);
  assert.equal(spawnOptions?.env?.PORT, String(ports.app));
  assert.equal(spawnOptions?.env?.INTERNAL_PORT, String(ports.internal));
});

test("rejects runtime paths outside root/.artifacts/readme-capture", () => {
  assert.throws(
    () => assertCaptureRuntimePath("/repo", "/tmp/readme-capture/runtime"),
    /capture artifact/i,
  );
  assert.throws(
    () =>
      assertCaptureRuntimePath(
        path.parse(process.cwd()).root,
        "/.artifacts/readme-capture/runtime",
      ),
    /broad repository root/i,
  );
});

test("rejects a capture runtime that traverses a symlink", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deskrpg-runtime-link-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const artifacts = path.join(root, ".artifacts");
  const outside = path.join(root, "outside");
  fs.mkdirSync(artifacts);
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(artifacts, "readme-capture"));

  assert.throws(
    () => assertCaptureRuntimePath(root, path.join(root, ".artifacts/readme-capture/runtime")),
    /symlink/i,
  );
});

test("rejects production app URLs", () => {
  assert.throws(() => createFixtureApi("https://deskrpg.com"), /loopback/i);
});

for (const component of ["data", "data/db.sqlite"]) {
  for (const dangling of [false, true]) {
    test(`rejects ${dangling ? "dangling" : "existing"} ${component} symlink before any startup side effects`, async (t) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "deskrpg-database-link-"));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const runtime = path.join(root, ".artifacts/readme-capture/runtime");
      const link = path.join(runtime, component);
      const target = path.join(root, "outside", component);
      fs.mkdirSync(path.dirname(link), { recursive: true });
      if (!dangling) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        if (component === "data") fs.mkdirSync(target);
        else fs.writeFileSync(target, "untouched");
      }
      fs.symlinkSync(target, link);
      let spawned = 0;
      let requested = 0;
      await assert.rejects(
        () =>
          runCaptureSession({
            root,
            spawn: (() => {
              spawned += 1;
              return runningChild().child;
            }) as typeof nodeSpawn,
            fetch: (async () => {
              requested += 1;
              return Response.json({});
            }) as typeof fetch,
          }),
        /symlink/i,
      );
      assert.equal(spawned, 0);
      assert.equal(requested, 0);
      if (dangling) assert.equal(fs.existsSync(target), false);
      else if (component === "data") assert.deepEqual(fs.readdirSync(target), []);
      else assert.equal(fs.readFileSync(target, "utf8"), "untouched");
    });
  }
}

test("the local fixture client resumes an existing account and retains its auth cookie", async () => {
  const seen: Array<{ path: string; cookie: string | null }> = [];
  const request = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const headers = new Headers(init?.headers);
    seen.push({ path: url.pathname, cookie: headers.get("cookie") });
    if (url.pathname === "/api/auth/register") {
      return Response.json({ errorCode: "login_id_taken" }, { status: 409 });
    }
    if (url.pathname === "/api/auth/login") {
      return Response.json(
        { user: { id: "user-1", nickname: "Dante" } },
        { headers: { "Set-Cookie": "token=capture-cookie; Path=/; HttpOnly" } },
      );
    }
    return Response.json({ groups: [] });
  };
  const api = createFixtureApi("http://127.0.0.1:3310", request as typeof fetch);

  const registration = await api.request<{ existing: boolean }>("POST", "/api/auth/register", {
    loginId: "readme-capture",
    password: "readme-capture-local-only",
  });
  await api.request("GET", "/api/groups");

  assert.equal(registration.existing, true);
  assert.deepEqual(seen, [
    { path: "/api/auth/register", cookie: null },
    { path: "/api/auth/login", cookie: null },
    { path: "/api/groups", cookie: "token=capture-cookie" },
  ]);
});

test("refuses to start or mutate fixtures while the capture app port is occupied", async (t) => {
  const ports = await freePorts();
  const blocker = createServer();
  await new Promise<void>((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(ports.app, "127.0.0.1", resolve);
  });
  t.after(() => new Promise<void>((resolve) => blocker.close(() => resolve())));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deskrpg-occupied-port-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let spawnCount = 0;
  let fetchCount = 0;

  await assert.rejects(
    () =>
      runCaptureSession({
        root,
        spawn: (() => {
          spawnCount += 1;
          return runningChild().child;
        }) as typeof nodeSpawn,
        fetch: (async () => {
          fetchCount += 1;
          return Response.json({});
        }) as typeof fetch,
        ports,
      }),
    /exclusive|already in use/i,
  );
  assert.equal(spawnCount, 0);
  assert.equal(fetchCount, 0);
});

test("rejects a healthy response that does not identify the owned capture instance", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deskrpg-instance-health-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fake = runningChild();
  const spawn = (() => fake.child) as typeof nodeSpawn;
  const ports = await freePorts();

  await assert.rejects(
    () =>
      runCaptureSession({
        root,
        spawn,
        ports,
        kill: fake.groupKill,
        fetch: (async () =>
          Response.json({
            instanceId: "some-other-server",
            listenerAddress: "127.0.0.1",
          })) as typeof fetch,
      }),
    /owned capture instance/i,
  );
  assert.equal(fake.wasKilled(), true);
});

test("SIGTERM cancels pending startup and cleans up the owned process group", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deskrpg-signal-cleanup-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const signals = new EventEmitter();
  const fake = runningChild();
  const spawn = (() => fake.child) as typeof nodeSpawn;
  const groupSignals: Array<{ pid: number; signal: NodeJS.Signals | number | undefined }> = [];
  const kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    groupSignals.push({ pid, signal });
    queueMicrotask(() => fake.child.emit("exit", null, signal));
    return true;
  }) as typeof process.kill;
  const pendingFetch = ((_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })) as typeof fetch;

  const session = runCaptureSession({
    root,
    spawn,
    fetch: pendingFetch,
    signals,
    kill,
    ports: await freePorts(),
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  signals.emit("SIGTERM", "SIGTERM");

  await assert.rejects(() => session, /SIGTERM/i);
  assert.deepEqual(groupSignals, [{ pid: -44001, signal: "SIGTERM" }]);
});

test("terminates the whole owned process group instead of only the npm wrapper", async () => {
  const fake = runningChild();
  const killed: number[] = [];
  const kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    killed.push(pid);
    queueMicrotask(() => fake.child.emit("exit", null, signal));
    return true;
  }) as typeof process.kill;

  await terminateOwnedChild(fake.child, kill);

  assert.deepEqual(killed, [-44001]);
  assert.equal(fake.wasKilled(), false);
});

// Wall-clock cap. The runner waits for each file to finish, so if this test hangs the whole run hangs
// (measured: a 25-minute stall at the merge gate). The 120s boot budget plus cleanup margin.
const REAL_SERVER_TEST_TIMEOUT_MS = 180_000;
/** Cap for a single request. If the server accepts the connection but never answers, a fetch without a timeout waits forever. */
const HEALTH_REQUEST_TIMEOUT_MS = 2_000;

test(
  "the real capture server ignores repository env files and listens on IPv4 loopback",
  { timeout: REAL_SERVER_TEST_TIMEOUT_MS },
  async (t) => {
    const sourceRoot = path.resolve(import.meta.dirname, "../..");
    const testArtifacts = path.join(sourceRoot, ".artifacts/readme-capture");
    fs.mkdirSync(testArtifacts, { recursive: true });
    const root = fs.mkdtempSync(path.join(testArtifacts, "env-project-"));
    let stopServer = async () => {};
    const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "deskrpg-real-listener-"));
    t.after(async () => {
      await stopServer();
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
      fs.rmSync(runtime, { recursive: true, force: true });
    });
    // Copy the actual entry/config and reference read-only source/dependencies. All env files
    // and Next build output belong to this test, regardless of the developer's local env files.
    for (const file of ["dev-server.ts", "package.json", "tsconfig.json"])
      fs.copyFileSync(path.join(sourceRoot, file), path.join(root, file));
    for (const dir of ["src", "node_modules"])
      fs.symlinkSync(path.join(sourceRoot, dir), path.join(root, dir));
    fs.writeFileSync(
      path.join(root, "next.config.js"),
      `module.exports = { turbopack: { root: ${JSON.stringify(sourceRoot)} } };\n`,
    );
    const sentinelPath = path.join(root, ".env.development.local");
    fs.writeFileSync(sentinelPath, "README_CAPTURE_ENV_SENTINEL=restored-from-repository\n");

    const portProbe = createServer();
    await new Promise<void>((resolve, reject) => {
      portProbe.once("error", reject);
      portProbe.listen(0, "127.0.0.1", resolve);
    });
    const address = portProbe.address();
    assert.ok(address && typeof address === "object");
    const port = address.port;
    await new Promise<void>((resolve) => portProbe.close(() => resolve()));

    const instanceId = "real-listener-sentinel-test";
    const child = spawnProcess(
      process.execPath,
      ["--import", "tsx", path.join(sourceRoot, "scripts/readme-capture/server-launcher.ts")],
      {
        cwd: root,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH,
          HOME: runtime,
          NODE_ENV: "development",
          DB_TYPE: "sqlite",
          SQLITE_PATH: path.join(runtime, "db.sqlite"),
          JWT_SECRET: "readme-capture-listener-test-secret",
          PORT: String(port),
          DESKRPG_CAPTURE_MODE: "1",
          DESKRPG_CAPTURE_INSTANCE_ID: instanceId,
          DESKRPG_PROJECT_ROOT: root,
          DESKRPG_CAPTURE_PARENT_PID: String(process.pid),
        },
      },
    );
    let output = "";
    child.stdout?.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      output += String(chunk);
    });
    // Even after a timeout, node:test waits for this file's process to end. If the launcher forwards SIGTERM,
    // a live child's pipe holds that process and the whole runner stalls (measured: a 6-hour stall).
    // So send SIGKILL after SIGTERM, and close the pipes either way so this file ends.
    stopServer = async () => {
      const exited = () => child.exitCode !== null || child.signalCode !== null;
      const waitExit = (ms: number) =>
        new Promise<void>((resolve) => {
          if (exited()) return resolve();
          child.once("exit", () => resolve());
          setTimeout(resolve, ms).unref();
        });
      const signalGroup = (signal: NodeJS.Signals) => {
        if (!child.pid || exited()) return;
        try {
          process.kill(-child.pid, signal);
        } catch {}
      };
      signalGroup("SIGTERM");
      await waitExit(2_000);
      signalGroup("SIGKILL");
      await waitExit(2_000);
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
    };

    // A full test run competes for the machine, so give the dev server a generous budget and stop
    // early when the child dies — waiting out the clock on a crashed server hides the real reason.
    let health: Response | null = null;
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      try {
        // The kernel still accepts connections for a server whose event loop is stopped. Without a per-request cap this line
        // waits forever and the deadline below is never re-evaluated (reproduced with SIGSTOP).
        health = await fetch(`http://127.0.0.1:${port}/__readme-capture/health`, {
          signal: AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS),
        });
        if (health.ok) break;
      } catch {}
      if (child.exitCode !== null || child.signalCode !== null) {
        assert.fail(
          `capture server exited before answering (code ${child.exitCode}, signal ${child.signalCode}): ${output}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.ok(health?.ok, `capture server did not expose its health sentinel: ${output}`);
    const payload = await health.json();
    // The probe frees its port before the child claims it, so another listener can slip in between.
    // Say so instead of reporting the sentinel as wrong.
    assert.equal(
      (payload as { instanceId?: string }).instanceId,
      instanceId,
      `port ${port} answered for a different capture server; another listener took it`,
    );
    assert.deepEqual(payload, {
      instanceId,
      listenerAddress: "127.0.0.1",
      repositoryEnvLoaded: false,
    });
  },
);
