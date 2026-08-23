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

test("나란히 두 번 불러도 하나만 만든다", async () => {
  // 이것이 이 캐시의 존재 이유다. 완성된 값을 캐시했다면 생성이 비동기인 동안 창이
  // 열려, 두 호출이 각자 인스턴스를 만들고 둘 다 살아남는다.
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

test("null 은 캐시하지 않는다 — 다음 호출이 다시 시도한다", async () => {
  // null 은 "아직 만들 수 없다"이지 "없다"가 아니다. 자유채팅에서는 채널에 NPC 가
  // 아직 없는 상태이고, 나중에 배치되면 그때는 만들어져야 한다.
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

test("실패는 캐시에서 지워지고 그대로 던져진다", async () => {
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

test("늦게 끝난 실패가 그 사이 등록된 항목을 지우지 않는다", async () => {
  // `=== creating` 가드가 없으면 이 정리가 남의 항목을 지운다. 그러면 살아 있는
  // 런타임을 가리키던 캐시가 비어, 다음 지명이 두 번째 인스턴스를 만든다.
  const cache = new Map<string, Promise<string | null>>();
  const slow = deferred<string | null>();

  const failing = getOrCreateCached(cache, "ch", () => slow.promise);
  const newer = Promise.resolve("newer" as string | null);
  cache.set("ch", newer); // 그 사이 다른 경로가 새 항목을 넣었다

  slow.reject(new Error("late failure"));
  await assert.rejects(() => failing, /late failure/);

  assert.equal(cache.get("ch"), newer, "늦은 실패가 남의 항목을 지웠습니다.");
});
