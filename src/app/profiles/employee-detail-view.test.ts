import assert from "node:assert/strict";
import test from "node:test";

import { deleteConfirmParams, deletedNoticeFrom, visibleSections } from "./employee-detail-view";

test("the delete confirmation text includes the usage numbers", () => {
  assert.deepEqual(deleteConfirmParams("oliver", { npcs: 2, channels: 2 }), {
    name: "oliver",
    npcs: "2",
    channels: "2",
  });
});

test("if usage could not be read, ask with 0 — do not invent numbers", () => {
  assert.deepEqual(deleteConfirmParams("oliver", null), {
    name: "oliver",
    npcs: "0",
    channels: "0",
  });
  assert.deepEqual(deleteConfirmParams("oliver", { npcs: "설명 불가" }), {
    name: "oliver",
    npcs: "0",
    channels: "0",
  });
});

test("the post-delete notice reads the server's deletedNpcs and channels as is", () => {
  // The old code read `unboundNpcs`, so the notice always computed 0 and quietly disappeared.
  assert.deepEqual(deletedNoticeFrom({ ok: true, deletedNpcs: 2, channels: 2 }), {
    npcs: 2,
    channels: 2,
  });
  assert.equal(deletedNoticeFrom({ ok: true, unboundNpcs: 2 }), null);
  assert.equal(deletedNoticeFrom({ ok: true, deletedNpcs: 0 }), null);
});

test("shared users are not shown persona, appearance or account editing", () => {
  assert.deepEqual(visibleSections(true), ["status", "persona", "account"]);
  assert.deepEqual(visibleSections(false), ["status"]);
});
