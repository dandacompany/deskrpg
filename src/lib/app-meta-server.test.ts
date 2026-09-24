import assert from "node:assert/strict";
import test from "node:test";

import { createAppMetaCache } from "./app-meta-server";

const REPO = "https://api.github.com/repos/dandacompany/deskrpg";

function fakeFetch(responses: Record<string, unknown>) {
  const calls: string[] = [];
  const fetchJson = async (url: string) => {
    calls.push(url);
    const r = responses[url];
    if (r instanceof Error) throw r;
    return r;
  };
  return { fetchJson, calls };
}

test("returns star count and latest release tag, and does not re-ask within the TTL", async () => {
  let now = 0;
  const { fetchJson, calls } = fakeFetch({
    [REPO]: { stargazers_count: 1234 },
    [`${REPO}/releases/latest`]: { tag_name: "2026.922.0" },
  });
  const cache = createAppMetaCache({ fetchJson, now: () => now, ttlMs: 1000, failureTtlMs: 100 });
  const first = await cache.get();
  assert.equal(first.stars, 1234);
  assert.equal(first.latestVersion, "2026.922.0");
  await cache.get();
  assert.equal(calls.length, 2);
  now = 1001;
  await cache.get();
  assert.equal(calls.length, 4);
});

test("if one call fails, the other value survives, and the failure is cached briefly", async () => {
  let now = 0;
  const { fetchJson, calls } = fakeFetch({
    [REPO]: new Error("rate limited"),
    [`${REPO}/releases/latest`]: { tag_name: "v2026.922.0" },
  });
  const cache = createAppMetaCache({ fetchJson, now: () => now, ttlMs: 1000, failureTtlMs: 100 });
  const meta = await cache.get();
  assert.equal(meta.stars, null);
  assert.equal(meta.latestVersion, "2026.922.0");
  now = 101;
  await cache.get();
  assert.equal(calls.length, 4);
});

test("a malformed response is treated as null", async () => {
  const { fetchJson } = fakeFetch({
    [REPO]: { stargazers_count: "many" },
    [`${REPO}/releases/latest`]: {},
  });
  const meta = await createAppMetaCache({ fetchJson, now: () => 0 }).get();
  assert.deepEqual([meta.stars, meta.latestVersion], [null, null]);
});
