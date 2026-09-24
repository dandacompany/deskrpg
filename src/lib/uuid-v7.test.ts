import assert from "node:assert/strict";
import test from "node:test";
import { uuidv7 } from "./uuid-v7";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test("1000 created in a row strictly increase as strings — this is the whole reason this module exists", () => {
  const ids = Array.from({ length: 1000 }, () => uuidv7());
  for (let i = 1; i < ids.length; i += 1) {
    assert.ok(
      ids[i] > ids[i - 1],
      `${i}번째가 앞 것보다 작거나 같다: ${ids[i - 1]} → ${ids[i]}\n` +
        "같은 밀리초 안에서 순서가 뒤집히면 '최근 N 줄'이 다시 비결정적이 된다.",
    );
  }
  assert.equal(new Set(ids).size, 1000, "중복이 없다");
});

test("version nibble is 7, variant is 10, format is UUID", () => {
  for (let i = 0; i < 100; i += 1) {
    const id = uuidv7();
    assert.match(id, UUID_RE, id);
    assert.equal(id[14], "7", `버전 니블이 7 이 아니다: ${id}`);
    assert.ok("89ab".includes(id[19]), `variant 비트가 10 이 아니다: ${id}`);
  }
});

test("the leading 48 bits are the current Unix millisecond — the sort key is the timestamp", () => {
  const before = Date.now();
  const id = uuidv7();
  const after = Date.now();
  const ms = parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
  assert.ok(ms >= before && ms <= after + 1, `${ms} 이 [${before}, ${after}] 밖이다`);
});
