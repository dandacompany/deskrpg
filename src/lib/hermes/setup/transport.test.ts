import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTransportRegistry } from "./transport";
test("persistent target identity reconnects after registry restart and preserves profile paths", async () => {
  process.env.DESKRPG_SETUP_SSH_HOSTS = "test-host";
  const dir = await mkdtemp(path.join(os.tmpdir(), "ssh-transport-"));
  try {
    const first = createTransportRegistry(dir, async () => "http://127.0.0.1:11111");
    const stable = await first.register("test-host", 8642);
    assert.match(stable, /^http:\/\/[a-f0-9]{64}\.deskrpg-ssh\.invalid$/);
    assert.equal(
      await first.resolve(stable + "/p/alice/v1/models?q=1"),
      "http://127.0.0.1:11111/p/alice/v1/models?q=1",
    );
    const restarted = createTransportRegistry(dir, async (host, port) => {
      assert.equal(host, "test-host");
      assert.equal(port, 8642);
      return "http://127.0.0.1:22222";
    });
    assert.equal(await restarted.resolve(stable + "/health"), "http://127.0.0.1:22222/health");
    assert.equal(await restarted.register("test-host", 8642), stable);
    const names = await readdir(dir);
    assert.equal(names.length, 1);
    assert.equal((await stat(path.join(dir, names[0]))).mode & 0o777, 0o600);
    await writeFile(
      path.join(dir, names[0]),
      JSON.stringify({ hostId: "test-host", remotePort: 9999 }),
    );
    await assert.rejects(restarted.resolve(stable), /setup_invalid_request/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("unknown transport mappings fail closed and ordinary URL needs no filesystem", async () => {
  const registry = createTransportRegistry("/nonexistent-deskrpg-test", async () => {
    throw Error("unexpected SSH");
  });
  assert.equal(await registry.resolve("https://example.com/p/a"), "https://example.com/p/a");
  await assert.rejects(
    registry.resolve("http://" + "a".repeat(64) + ".deskrpg-ssh.invalid/health"),
    /ssh_unknown_host/,
  );
  await assert.rejects(registry.resolve("http://bad.deskrpg-ssh.invalid"), /setup_invalid_request/);
  await assert.rejects(registry.register("test-host", 0), /setup_invalid_request/);
});

test("owned tunnel deduplicates concurrent requests, reconnects after exit, fails host-key changes closed", async () => {
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  const { ensureSshTunnel, closeSshTunnels } = await import("./transport");
  process.env.DESKRPG_SETUP_SSH_HOSTS = "test-host";
  const children: (InstanceType<typeof EventEmitter> & {
    stderr: InstanceType<typeof PassThrough>;
    kill(): boolean;
  })[] = [];
  const spawnImpl = ((command: string, args: string[]) => {
    assert.equal(command, "ssh");
    assert.ok(args.includes("ExitOnForwardFailure=yes"));
    const emitter = new EventEmitter();
    const child = Object.assign(emitter, {
      stderr: new PassThrough(),
      kill() {
        emitter.emit("exit", 0);
        return true;
      },
    });
    children.push(child);
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
  const dependencies = { spawnImpl, getPort: async () => 11111, forward: async () => {} };
  const urls = await Promise.all([
    ensureSshTunnel("test-host", 8642, dependencies),
    ensureSshTunnel("test-host", 8642, dependencies),
  ]);
  assert.deepEqual(urls, ["http://127.0.0.1:11111", "http://127.0.0.1:11111"]);
  assert.equal(children.length, 1);
  children[0].emit("exit", 1);
  await ensureSshTunnel("test-host", 8642, dependencies);
  assert.equal(children.length, 2);
  await closeSshTunnels();
  const rejected = ensureSshTunnel("test-host", 8642, {
    ...dependencies,
    forward: async () => {
      children.at(-1)!.stderr.emit("data", Buffer.from("SECRET Host key verification failed"));
      throw Error("unavailable");
    },
  });
  await assert.rejects(
    rejected,
    (error) =>
      error instanceof Error &&
      /ssh_host_key_failed/.test(error.message) &&
      !error.message.includes("SECRET"),
  );
  await closeSshTunnels();
});

test("win32 checks readiness with a local port probe instead of a control socket", async () => {
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  const { createServer } = await import("node:net");
  const { ensureSshTunnel, closeSshTunnels } = await import("./transport");
  const originalHosts = process.env.DESKRPG_SETUP_SSH_HOSTS;
  process.env.DESKRPG_SETUP_SSH_HOSTS = "test-host";
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "win32" });
  const server = createServer((socket) => socket.end());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  try {
    let capturedArgs: string[] = [];
    const spawnImpl = ((command: string, args: string[]) => {
      capturedArgs = args;
      const emitter = new EventEmitter();
      return Object.assign(emitter, { stderr: new PassThrough(), kill: () => true });
    }) as unknown as typeof import("node:child_process").spawn;
    const url = await ensureSshTunnel("test-host", 8642, {
      spawnImpl,
      getPort: async () => port,
    });
    assert.equal(url, `http://127.0.0.1:${port}`);
    assert.ok(!capturedArgs.includes("-M") && !capturedArgs.includes("-S"));
    assert.ok(capturedArgs.join(" ").includes("ControlMaster=no"));
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform });
    if (originalHosts === undefined) delete process.env.DESKRPG_SETUP_SSH_HOSTS;
    else process.env.DESKRPG_SETUP_SSH_HOSTS = originalHosts;
    await closeSshTunnels();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("transport fetch refuses redirects even when caller requests follow", async () => {
  const { transportFetch } = await import("./transport");
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (url, init) => {
      assert.equal(url, "https://example.com/health");
      assert.equal(init?.redirect, "error");
      return new Response("{}");
    }) as typeof fetch;
    await transportFetch("https://example.com/health", { redirect: "follow" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
