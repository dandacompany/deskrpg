import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ChatQuota, DEFAULT_CHAT_BUDGET } from "./chat-quota";

describe("ChatQuota", () => {
  test("the default budget is 6", () => {
    assert.equal(DEFAULT_CHAT_BUDGET, 6);
    assert.equal(new ChatQuota().remaining(), 6);
  });

  test("spend deducts and returns true while budget remains", () => {
    const q = new ChatQuota(2);
    assert.equal(q.spend(), true);
    assert.equal(q.remaining(), 1);
    assert.equal(q.spend(), true);
    assert.equal(q.remaining(), 0);
  });

  test("returns false when out of budget and never goes negative", () => {
    const q = new ChatQuota(1);
    q.spend();
    assert.equal(q.spend(), false);
    assert.equal(q.remaining(), 0);
    assert.equal(q.spend(), false);
    assert.equal(q.remaining(), 0);
  });

  test("a human speaking refills the budget", () => {
    const q = new ChatQuota(3);
    q.spend();
    q.spend();
    q.spend();
    assert.equal(q.remaining(), 0);
    q.resetByHuman();
    assert.equal(q.remaining(), 3);
    assert.equal(q.spend(), true);
  });

  test("a budget of 0 means the NPC chain never continues", () => {
    const q = new ChatQuota(0);
    assert.equal(q.spend(), false);
  });
});
