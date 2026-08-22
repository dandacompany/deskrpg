import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { describe, test } from "node:test";

import { SubprocessPool } from "./subprocess-pool";

describe("SubprocessPool", () => {
  test("basic execution collects stdout", async () => {
    const pool = new SubprocessPool();
    const result = await pool.execute({
      command: "node",
      args: ["-e", 'process.stdout.write("hello")'],
    });

    assert.equal(result.fullOutput, "hello");
    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");
  });

  test("stdin is piped through stdin instead of arguments", async () => {
    const pool = new SubprocessPool();
    const result = await pool.execute({
      command: "node",
      args: [
        "-e",
        'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>process.stdout.write(d.toUpperCase()))',
      ],
      stdin: "test input",
    });

    assert.equal(result.fullOutput, "TEST INPUT");
    assert.equal(result.exitCode, 0);
  });

  test("streams stdout chunks to callback", async () => {
    const pool = new SubprocessPool();
    const chunks: string[] = [];

    const result = await pool.execute({
      command: "node",
      args: ["-e", 'process.stdout.write("alpha");setTimeout(()=>process.stdout.write("beta"),20)'],
      onStdout: (chunk) => {
        chunks.push(chunk);
      },
    });

    assert.equal(result.fullOutput, "alphabeta");
    assert.equal(chunks.join(""), "alphabeta");
    assert.ok(chunks.length >= 1);
  });

  test("kills timed out processes and records a reasonable duration", async () => {
    const pool = new SubprocessPool();
    const startedAt = Date.now();

    const result = await pool.execute({
      command: "node",
      args: ["-e", "setTimeout(()=>{},60000)"],
      timeoutMs: 500,
    });

    const wallClockMs = Date.now() - startedAt;

    assert.equal(result.exitCode, -1);
    assert.match(result.stderr, /timed out/i);
    assert.ok(result.durationMs >= 450, `duration was ${result.durationMs}ms`);
    assert.ok(result.durationMs < 6_000, `duration was ${result.durationMs}ms`);
    assert.ok(wallClockMs < 6_000, `wall clock was ${wallClockMs}ms`);
  });

  test("captures non-zero exit codes", async () => {
    const pool = new SubprocessPool();
    const result = await pool.execute({
      command: "node",
      args: ["-e", "process.exit(42)"],
    });

    assert.equal(result.exitCode, 42);
    assert.equal(result.fullOutput, "");
  });

  test("getStatus reports active and queued counts", async () => {
    const pool = new SubprocessPool({ maxConcurrent: 1 });

    const first = pool.execute({
      command: "node",
      args: ["-e", 'setTimeout(()=>process.stdout.write("first"),250)'],
    });
    const second = pool.execute({
      command: "node",
      args: ["-e", 'setTimeout(()=>process.stdout.write("second"),250)'],
    });

    const statusWhileBusy = pool.getStatus();

    assert.equal(statusWhileBusy.maxConcurrent, 1);
    assert.equal(statusWhileBusy.activeCount, 1);
    assert.equal(statusWhileBusy.queuedCount, 1);
    assert.deepEqual(statusWhileBusy.activeRequestIds, [first.requestId]);
    assert.deepEqual(statusWhileBusy.queuedRequestIds, [second.requestId]);

    await Promise.all([first, second]);

    const statusAfter = pool.getStatus();
    assert.equal(statusAfter.activeCount, 0);
    assert.equal(statusAfter.queuedCount, 0);
  });

  test("enforces concurrency limits and drains the queue", async () => {
    const pool = new SubprocessPool({ maxConcurrent: 2 });
    const startedAt = Date.now();

    const first = pool.execute({
      command: "node",
      args: ["-e", 'setTimeout(()=>process.stdout.write("one"),250)'],
    });
    const second = pool.execute({
      command: "node",
      args: ["-e", 'setTimeout(()=>process.stdout.write("two"),250)'],
    });
    const third = pool.execute({
      command: "node",
      args: ["-e", 'setTimeout(()=>process.stdout.write("three"),250)'],
    });

    const statusDuringRun = pool.getStatus();
    assert.equal(statusDuringRun.activeCount, 2);
    assert.equal(statusDuringRun.queuedCount, 1);
    assert.ok(statusDuringRun.activeRequestIds.includes(first.requestId));
    assert.ok(statusDuringRun.activeRequestIds.includes(second.requestId));
    assert.deepEqual(statusDuringRun.queuedRequestIds, [third.requestId]);

    const [firstResult, secondResult, thirdResult] = await Promise.all([first, second, third]);
    const elapsedMs = Date.now() - startedAt;

    assert.deepEqual(
      [firstResult.fullOutput, secondResult.fullOutput, thirdResult.fullOutput].sort(),
      ["one", "three", "two"],
    );
    assert.ok(elapsedMs >= 400, `elapsed ${elapsedMs}ms did not show queueing`);
    assert.equal(pool.getStatus().activeCount, 0);
    assert.equal(pool.getStatus().queuedCount, 0);
  });

  test("kill aborts a running request", async () => {
    const pool = new SubprocessPool();
    const execution = pool.execute({
      command: "node",
      args: ["-e", "setTimeout(()=>{},60000)"],
    });

    await delay(50);
    const killed = pool.kill(execution.requestId);
    const result = await execution;

    assert.equal(killed, true);
    assert.equal(result.exitCode, -1);
    assert.match(result.stderr, /aborted/i);
  });
});
