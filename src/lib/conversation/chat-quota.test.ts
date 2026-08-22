import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ChatQuota, DEFAULT_CHAT_BUDGET } from "./chat-quota";

describe("ChatQuota", () => {
  test("기본 예산은 6이다", () => {
    assert.equal(DEFAULT_CHAT_BUDGET, 6);
    assert.equal(new ChatQuota().remaining(), 6);
  });

  test("spend 는 남아 있으면 차감하고 true", () => {
    const q = new ChatQuota(2);
    assert.equal(q.spend(), true);
    assert.equal(q.remaining(), 1);
    assert.equal(q.spend(), true);
    assert.equal(q.remaining(), 0);
  });

  test("예산이 없으면 false 를 돌려주고 음수로 내려가지 않는다", () => {
    const q = new ChatQuota(1);
    q.spend();
    assert.equal(q.spend(), false);
    assert.equal(q.remaining(), 0);
    assert.equal(q.spend(), false);
    assert.equal(q.remaining(), 0);
  });

  test("사람이 말하면 예산이 가득 찬다", () => {
    const q = new ChatQuota(3);
    q.spend();
    q.spend();
    q.spend();
    assert.equal(q.remaining(), 0);
    q.resetByHuman();
    assert.equal(q.remaining(), 3);
    assert.equal(q.spend(), true);
  });

  test("예산 0 으로 만들면 NPC 사슬이 아예 안 이어진다", () => {
    const q = new ChatQuota(0);
    assert.equal(q.spend(), false);
  });
});
