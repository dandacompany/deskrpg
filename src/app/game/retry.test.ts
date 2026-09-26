import assert from "node:assert/strict";
import test from "node:test";

import { retryAfter } from "./retry";

test("a task that fails once is tried again and its result is returned", async () => {
  let calls = 0;
  const result = await retryAfter(async () => {
    calls += 1;
    if (calls === 1) throw new TypeError("Failed to fetch");
    return "ok";
  }, [0]);
  assert.equal(result, "ok");
  assert.equal(calls, 2);
});

test("after the last delay the final error is thrown", async () => {
  let calls = 0;
  await assert.rejects(
    retryAfter(async () => {
      calls += 1;
      throw new Error(`fail ${calls}`);
    }, [0, 0]),
    /fail 3/,
  );
  assert.equal(calls, 3);
});

test("waits the given delay between attempts", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const pending = retryAfter(async () => {
    calls += 1;
    if (calls === 1) throw new Error("once");
    return calls;
  }, [1000]);
  await Promise.resolve();
  assert.equal(calls, 1);
  t.mock.timers.tick(999);
  await Promise.resolve();
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  assert.equal(await pending, 2);
});
