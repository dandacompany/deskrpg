import assert from "node:assert/strict";
import test from "node:test";

import { getOrCreateCached } from "./promise-cache";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("creates only one when called twice in parallel", async () => {
  // This is why this cache exists. Had it cached the finished value, a window would open while
  // creation is async, and the two calls would each create an instance and both would survive.
  const cache = new Map<string, Promise<{ id: number } | null>>();
  const d = deferred<{ id: number } | null>();
  let calls = 0;

  const a = getOrCreateCached(cache, "ch", () => {
    calls++;
    return d.promise;
  });
  const b = getOrCreateCached(cache, "ch", () => {
    calls++;
    return d.promise;
  });

  assert.equal(calls, 1, "두 번째 호출이 팩토리를 또 불렀습니다.");
  d.resolve({ id: 1 });
  assert.equal(await a, await b);
  assert.strictEqual(await a, await b, "두 호출이 서로 다른 인스턴스를 받았습니다.");
});

test("does not cache null — the next call retries", async () => {
  // null means "cannot be created yet", not "does not exist". In free chat the channel has no NPC
  // yet, and once one is placed later it must be created then.
  const cache = new Map<string, Promise<string | null>>();
  let calls = 0;
  const create = async () => {
    calls++;
    return calls === 1 ? null : "runtime";
  };

  assert.equal(await getOrCreateCached(cache, "ch", create), null);
  assert.equal(cache.has("ch"), false, "null 이 캐시에 남았습니다.");
  assert.equal(await getOrCreateCached(cache, "ch", create), "runtime");
  assert.equal(calls, 2);
});

test("a failure is removed from the cache and rethrown as-is", async () => {
  const cache = new Map<string, Promise<string | null>>();
  let calls = 0;
  const create = async () => {
    calls++;
    if (calls === 1) throw new Error("DB down");
    return "runtime";
  };

  await assert.rejects(() => getOrCreateCached(cache, "ch", create), /DB down/);
  assert.equal(cache.has("ch"), false, "실패한 약속이 캐시에 남았습니다 — 영원히 실패합니다.");
  assert.equal(await getOrCreateCached(cache, "ch", create), "runtime");
});

test("a late failure does not remove an entry registered in the meantime", async () => {
  // Without the `=== creating` guard this cleanup removes someone else's entry. Then the cache that
  // pointed to a live runtime is emptied, and the next mention creates a second instance.
  const cache = new Map<string, Promise<string | null>>();
  const slow = deferred<string | null>();

  const failing = getOrCreateCached(cache, "ch", () => slow.promise);
  const newer = Promise.resolve("newer" as string | null);
  cache.set("ch", newer); // meanwhile another path inserted a new entry

  slow.reject(new Error("late failure"));
  await assert.rejects(() => failing, /late failure/);

  assert.equal(cache.get("ch"), newer, "늦은 실패가 남의 항목을 지웠습니다.");
});
