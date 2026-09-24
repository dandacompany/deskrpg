import assert from "node:assert/strict";
import test from "node:test";

import { orderApprovalBatch } from "./approval-batch-order";

const item = (parents: number[] = []) => ({ parents });

test("keeps the input order as-is when there are no parents", () => {
  assert.deepEqual(orderApprovalBatch([item(), item(), item()]), { ok: true, order: [0, 1, 2] });
});

test("a parent is created first — even when a later item points to an earlier one", () => {
  // 0 has 1 as a parent → 1 must be created first so 0's parents can be filled with an id.
  assert.deepEqual(orderApprovalBatch([item([1]), item()]), { ok: true, order: [1, 0] });
});

test("order is preserved even with a long chain", () => {
  assert.deepEqual(orderApprovalBatch([item([1]), item([2]), item()]), {
    ok: true,
    order: [2, 1, 0],
  });
});

test("creates the same parent only once even when several items point to it", () => {
  const r = orderApprovalBatch([item(), item([0]), item([0])]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.ok && r.order, [0, 1, 2]);
});

test("keeps the input order when parent order ties — the result doesn't waver", () => {
  assert.deepEqual(orderApprovalBatch([item([2]), item([2]), item()]), {
    ok: true,
    order: [2, 0, 1],
  });
});

test("rejects a parent index that's out of range", () => {
  assert.deepEqual(orderApprovalBatch([item([5])]), {
    ok: false,
    error: "parent_out_of_range",
    index: 0,
  });
  assert.deepEqual(orderApprovalBatch([item([-1])]), {
    ok: false,
    error: "parent_out_of_range",
    index: 0,
  });
});

test("rejects an item that has itself as a parent", () => {
  assert.deepEqual(orderApprovalBatch([item([0])]), { ok: false, error: "parent_cycle", index: 0 });
});

test("rejects a cycle — never creates a card that waits forever", () => {
  const r = orderApprovalBatch([item([1]), item([0])]);
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.error, "parent_cycle");
});

test("an empty batch has an empty order", () => {
  assert.deepEqual(orderApprovalBatch([]), { ok: true, order: [] });
});
