import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { isTerminalEvent, readCapability, readMaxConcurrentRuns } from "./types";

describe("isTerminalEvent", () => {
  test("terminal events end the stream", () => {
    for (const name of ["run.completed", "run.cancelled", "run.failed", "error", "done"]) {
      assert.equal(isTerminalEvent(name), true, name);
    }
  });

  test("streaming events do not end the stream", () => {
    for (const name of ["run.started", "assistant.delta", "tool.progress", "assistant.completed"]) {
      assert.equal(isTerminalEvent(name), false, name);
    }
  });
});

describe("readCapability", () => {
  test("reads a true feature flag", () => {
    assert.equal(
      readCapability({ features: { run_steer: true }, endpoints: {} }, "run_steer"),
      true,
    );
  });

  test("returns false for a missing flag", () => {
    assert.equal(readCapability({ features: {}, endpoints: {} }, "run_steer"), false);
  });

  test("fails closed when capabilities are unavailable", () => {
    assert.equal(readCapability(null, "run_steer"), false);
  });
});

describe("readMaxConcurrentRuns", () => {
  test("reads the configured limit", () => {
    const caps = { features: { max_concurrent_runs: 8 }, endpoints: {} };
    assert.equal(readMaxConcurrentRuns(caps), 8);
  });

  test("falls back to a conservative default when unknown", () => {
    assert.equal(readMaxConcurrentRuns(null), 4);
    assert.equal(readMaxConcurrentRuns({ features: {}, endpoints: {} }), 4);
  });
});
