import assert from "node:assert/strict";
import test from "node:test";

import { decideTargets, nextApprovalStatus, parseDecision } from "./approval-decision";

test("there are only three decisions", () => {
  assert.equal(parseDecision("approve"), "approve");
  assert.equal(parseDecision("reject"), "reject");
  assert.equal(parseDecision("request_revision"), "request_revision");
  for (const bad of ["", "APPROVE", "unblock", null, 7, undefined])
    assert.equal(parseDecision(bad), null, String(bad));
});

test("approve maps to approved, reject to rejected, request_revision to revision_requested", () => {
  assert.equal(nextApprovalStatus("approve"), "approved");
  assert.equal(nextApprovalStatus("reject"), "rejected");
  assert.equal(nextApprovalStatus("request_revision"), "revision_requested");
});

const all = ["t1", "t2", "t3"];

test("if no targets are selected, everything follows the decision", () => {
  assert.deepEqual(decideTargets(all, undefined, "approve"), {
    ok: true,
    unblock: ["t1", "t2", "t3"],
    perTarget: [],
  });
});

test("a partial rejection blocks only that card, and the rest follow the overall approval", () => {
  const r = decideTargets(
    all,
    [
      { taskId: "t1", decision: "approve" },
      { taskId: "t2", decision: "reject" },
    ],
    "approve",
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.unblock, ["t1", "t3"], "t2 만 막히고 고르지 않은 t3 는 풀린다");
  assert.deepEqual(r.perTarget, [
    { taskId: "t1", decision: "approve" },
    { taskId: "t2", decision: "reject" },
  ]);
});

test("an unselected target follows the overall approval decision", () => {
  // Sent without t3 — if the overall approval is approve, t3 is unblocked too.
  const r = decideTargets(all, [{ taskId: "t1", decision: "reject" }], "approve");
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.unblock, ["t2", "t3"]);
});

test("rejecting unblocks nothing — even with a partial target specified", () => {
  const r = decideTargets(all, [{ taskId: "t1", decision: "approve" }], "reject");
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.unblock, ["t1"], "반려 안에서도 명시적으로 승인한 것은 푼다");
});

test("requesting revision unblocks nothing", () => {
  assert.deepEqual(decideTargets(all, undefined, "request_revision"), {
    ok: true,
    unblock: [],
    perTarget: [],
  });
});

test("targeting a card that's not part of this approval is rejected", () => {
  assert.deepEqual(decideTargets(all, [{ taskId: "ghost", decision: "approve" }], "approve"), {
    ok: false,
    error: "target_not_in_approval",
    taskId: "ghost",
  });
});

test("targeting the same card twice is rejected — there's no way to decide which one wins", () => {
  assert.deepEqual(
    decideTargets(
      all,
      [
        { taskId: "t1", decision: "approve" },
        { taskId: "t1", decision: "reject" },
      ],
      "approve",
    ),
    { ok: false, error: "target_duplicated", taskId: "t1" },
  );
});
