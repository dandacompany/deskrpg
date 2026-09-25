import assert from "node:assert/strict";
import test from "node:test";
import { shouldToastAccessDenied } from "./access-denied-toast";

test("the meeting-room availability probe never toasts — the meeting button shows its own state", () => {
  assert.equal(
    shouldToastAccessDenied({ action: "meeting:availability", errorCode: "forbidden" }),
    false,
  );
  assert.equal(
    shouldToastAccessDenied({ action: "meeting:availability", errorCode: "password_required" }),
    false,
  );
});

test("denials of something the user did still toast", () => {
  for (const action of ["player:join", "meeting:join", "meeting:chat", undefined]) {
    assert.equal(shouldToastAccessDenied({ action, errorCode: "forbidden" }), true, action);
  }
});
