import test from "node:test";
import assert from "node:assert/strict";

import { HermesClient, HermesError } from "./hermes-client";

function clientWith(responses: Array<{ status: number; retryAfter?: string }>) {
  let i = 0;
  const calls: number[] = [];
  const fetchImpl = (async () => {
    const spec = responses[Math.min(i, responses.length - 1)];
    i += 1;
    calls.push(spec.status);
    const headers = new Headers();
    if (spec.retryAfter) headers.set("Retry-After", spec.retryAfter);
    return new Response(spec.status === 200 ? "{}" : "too many", {
      status: spec.status,
      headers,
    });
  }) as unknown as typeof fetch;
  return {
    calls,
    client: new HermesClient({
      baseUrl: "http://gw",
      profileName: "sophie",
      token: "t",
      fetchImpl,
      // Keep the test from actually waiting.
      sleepImpl: async () => {},
    }),
  };
}

test("retries on 429 and returns the result on success", async () => {
  const { client, calls } = clientWith([{ status: 429, retryAfter: "0" }, { status: 200 }]);
  await client.getCapabilities();
  assert.deepEqual(calls, [429, 200]);
});

test("throws eventually on repeated 429 — never silently pretends to succeed", async () => {
  const { client, calls } = clientWith([{ status: 429, retryAfter: "0" }]);
  await assert.rejects(
    () => client.getCapabilities(),
    (err: unknown) => err instanceof HermesError && err.status === 429,
  );
  // 1 initial attempt + 2 retries.
  assert.equal(calls.length, 3);
});

test("does not retry failures other than 429", async () => {
  const { client, calls } = clientWith([{ status: 401 }]);
  await assert.rejects(() => client.getCapabilities());
  assert.equal(calls.length, 1);
});
