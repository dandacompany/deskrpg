import test from "node:test";
import assert from "node:assert/strict";

import { planPasswordChange } from "./change-plan";

test("does not send to the server when a field is empty", () => {
  assert.deepEqual(
    planPasswordChange({ current: "", next: "new-password", confirm: "new-password" }),
    {
      ok: false,
      errorCode: "current_new_password_required",
    },
  );
});

test("does not send to the server when the confirmation differs", () => {
  assert.deepEqual(
    planPasswordChange({ current: "old-password", next: "new-password", confirm: "new-passwerd" }),
    { ok: false, errorCode: "password_mismatch" },
  );
});

test("does not send to the server when shorter than 8 characters", () => {
  assert.deepEqual(
    planPasswordChange({ current: "old-password", next: "short", confirm: "short" }),
    {
      ok: false,
      errorCode: "password_length_invalid",
    },
  );
});

test("does not send to the server when equal to the current password", () => {
  assert.deepEqual(
    planPasswordChange({ current: "old-password", next: "old-password", confirm: "old-password" }),
    { ok: false, errorCode: "password_unchanged" },
  );
});

test("returns the body to send when everything passes", () => {
  assert.deepEqual(
    planPasswordChange({ current: "old-password", next: "new-password", confirm: "new-password" }),
    { ok: true, body: { currentPassword: "old-password", newPassword: "new-password" } },
  );
});
