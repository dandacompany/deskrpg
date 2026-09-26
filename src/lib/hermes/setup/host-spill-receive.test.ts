import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import test from "node:test";

import { discoverHost, receiveSpill } from "./host";
import type { HostExecutor } from "./types";

// The client half of a spilled reply: fetch it with scp into a private local directory, check it,
// then remove both copies — on success, failure and cancellation alike.

const REMOTE = "/tmp/deskrpg-spill-abc123/" + "0123456789abcdef".repeat(2);
const REPLY = JSON.stringify({ candidates: [], note: "t".repeat(70000) });
const pointer = (over: Record<string, unknown> = {}) => ({
  spill: REMOTE,
  bytes: Buffer.byteLength(REPLY),
  sha256: createHash("sha256").update(REPLY).digest("hex"),
  ...over,
});

type Calls = { inputs: Record<string, unknown>[]; fetched: string[]; locals: string[] };

function transport(options: {
  first?: Record<string, unknown>;
  fetch?: (local: string) => void | Promise<void>;
  cleanup?: Record<string, unknown>;
  fetchFile?: boolean;
}) {
  const calls: Calls = { inputs: [], fetched: [], locals: [] };
  const execute = Object.assign(
    async (_command: string, _args: string[], opts?: { input?: string }) => {
      const input = JSON.parse(opts?.input ?? "{}") as Record<string, unknown>;
      calls.inputs.push(input);
      const body =
        "cleanup_spill" in input ? (options.cleanup ?? { cleaned: true }) : options.first;
      return { code: 0, stdout: JSON.stringify(body), stderr: "" };
    },
    { stdoutLimit: 65536 },
    options.fetchFile === false
      ? {}
      : {
          fetchFile: async (remote: string, local: string) => {
            calls.fetched.push(remote);
            calls.locals.push(local);
            await (options.fetch ?? ((path: string) => writeFileSync(path, REPLY)))(local);
          },
        },
  ) as HostExecutor;
  return { execute, calls };
}

const cleanupRequests = (calls: Calls) =>
  calls.inputs.filter((input) => "cleanup_spill" in input).map((input) => input.cleanup_spill);

test("the helper is offered a spill only when the transport can fetch a file", async () => {
  const withFetch = transport({ first: { candidates: [] } });
  await discoverHost(withFetch.execute, "linux");
  assert.equal(withFetch.calls.inputs[0].spill, true);

  const without = transport({ first: { candidates: [] }, fetchFile: false });
  await discoverHost(without.execute, "linux");
  assert.equal(without.calls.inputs[0].spill, false);
});

test("a spilled reply is fetched, checked, returned, and both copies are removed", async () => {
  const { execute, calls } = transport({ first: pointer() });
  assert.deepEqual(await discoverHost(execute, "linux"), []);
  assert.deepEqual(calls.fetched, [REMOTE]);
  assert.deepEqual(cleanupRequests(calls), [REMOTE]);
  assert.equal(existsSync(dirname(calls.locals[0])), false, "the local copy is removed");
});

test("a failed fetch still cleans up the host and the local directory", async () => {
  const { execute, calls } = transport({
    first: pointer(),
    fetch: () => {
      throw new Error("scp exploded");
    },
  });
  await assert.rejects(discoverHost(execute, "linux"), /^Error: host_operation_failed$/);
  assert.deepEqual(cleanupRequests(calls), [REMOTE]);
  assert.equal(existsSync(dirname(calls.locals[0])), false);
});

test("a copy whose size or hash differs is rejected, and cleaned up", async () => {
  for (const bad of [{ bytes: 1 }, { sha256: "0".repeat(64) }]) {
    const { execute, calls } = transport({ first: pointer(bad) });
    await assert.rejects(discoverHost(execute, "linux"), /^Error: host_operation_failed$/);
    assert.deepEqual(cleanupRequests(calls), [REMOTE]);
  }
});

test("a host that cannot remove the spill is an explicit error, logged without the path", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const { execute } = transport({
    first: pointer(),
    cleanup: { error: "host_spill_cleanup_failed" },
  });
  await assert.rejects(discoverHost(execute, "linux"), /^Error: host_spill_cleanup_failed$/);
  const logged = JSON.stringify(warn.mock.calls.map((call) => call.arguments));
  assert.match(logged, /host_spill_cleanup_failed/);
  assert.equal(logged.includes("deskrpg-spill-"), false, "the log names no path");
});

test("a pointer that is not a spill file is refused without fetching or cleaning anything", async () => {
  for (const spill of [
    "/etc/passwd",
    "/tmp/deskrpg-spill-x/../../etc/" + "a".repeat(32),
    "relative/deskrpg-spill-x/" + "a".repeat(32),
    "/tmp/other/" + "a".repeat(32),
  ]) {
    const { execute, calls } = transport({ first: pointer({ spill }) });
    await assert.rejects(discoverHost(execute, "linux"), /^Error: host_operation_failed$/, spill);
    assert.deepEqual(calls.fetched, []);
    assert.deepEqual(cleanupRequests(calls), []);
  }
});

test("a Windows host's spill path is accepted", async () => {
  const windowsPath =
    "C:\\Users\\USER\\AppData\\Local\\Temp\\deskrpg-spill-q1w2e3\\" + "a1".repeat(16);
  const { execute, calls } = transport({ first: pointer({ spill: windowsPath }) });
  assert.deepEqual(await discoverHost(execute, "win32"), []);
  assert.deepEqual(calls.fetched, [windowsPath]);
  assert.deepEqual(cleanupRequests(calls), [windowsPath]);
});

test("a cancelled fetch still removes the spill on the host", async () => {
  const controller = new AbortController();
  const { execute, calls } = transport({
    first: pointer(),
    fetch: () => {
      controller.abort();
      throw new Error("aborted");
    },
  });
  await assert.rejects(
    receiveSpill(execute, "linux", pointer(), { timeoutMs: 1000, signal: controller.signal }),
  );
  assert.deepEqual(cleanupRequests(calls), [REMOTE]);
});
