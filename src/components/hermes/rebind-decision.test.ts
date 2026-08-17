import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { shouldRebindProfile } from "./rebind-decision";

describe("shouldRebindProfile", () => {
  test("hermes with a changed selection rebinds", () => {
    assert.equal(shouldRebindProfile("hermes", "profile-b", "profile-a"), true);
  });

  test("hermes with an unchanged selection does not rebind", () => {
    assert.equal(shouldRebindProfile("hermes", "profile-a", "profile-a"), false);
  });

  test("a null selection never rebinds, even when the current value is undefined", () => {
    assert.equal(shouldRebindProfile("hermes", null, undefined), false);
  });

  test("a null selection never rebinds against an existing current value", () => {
    assert.equal(shouldRebindProfile("hermes", null, "profile-a"), false);
  });

  test("a non-hermes adapter never rebinds, regardless of selection", () => {
    assert.equal(shouldRebindProfile("openclaw", "profile-b", "profile-a"), false);
  });
});
