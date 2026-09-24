import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CREATABLE_PROFILE_NAME_RE,
  RESERVED_PROFILE_NAMES,
  isCreatableProfileName,
} from "./creatable-profile-name";

describe("isCreatableProfileName — the grammar Hermes actually requires when creating a new profile", () => {
  it("accepts lowercase letters, digits, hyphens, and underscores", () => {
    assert.equal(isCreatableProfileName("noah"), true);
    assert.equal(isCreatableProfileName("noah2"), true);
    assert.equal(isCreatableProfileName("noah-2"), true);
    assert.equal(isCreatableProfileName("noah_2"), true);
    assert.equal(isCreatableProfileName("n"), true);
  });

  it("rejects uppercase", () => {
    // The registration PROFILE_NAME_RE allows uppercase, but for creation the Hermes server
    // actually rejects it (profiles.py:51 accepts only lowercase).
    assert.equal(isCreatableProfileName("Noah"), false);
    assert.equal(isCreatableProfileName("NOAH"), false);
  });

  it("rejects periods", () => {
    assert.equal(isCreatableProfileName("noah.dev"), false);
  });

  it("rejects names longer than 64 chars", () => {
    assert.equal(isCreatableProfileName("n".repeat(64)), true);
    assert.equal(isCreatableProfileName("n".repeat(65)), false);
  });

  it("rejects names starting with a hyphen or underscore", () => {
    assert.equal(isCreatableProfileName("-noah"), false);
    assert.equal(isCreatableProfileName("_noah"), false);
  });

  it("rejects the empty string", () => {
    assert.equal(isCreatableProfileName(""), false);
  });

  it("rejects the 5 reserved words", () => {
    for (const reserved of ["hermes", "test", "tmp", "root", "sudo"]) {
      assert.equal(isCreatableProfileName(reserved), false, reserved);
    }
  });

  it("also rejects default — it's a registration target, not a creation target", () => {
    assert.equal(isCreatableProfileName("default"), false);
  });
});

describe("CREATABLE_PROFILE_NAME_RE / RESERVED_PROFILE_NAMES — export shape", () => {
  it("the regex itself follows the same grammar", () => {
    assert.equal(CREATABLE_PROFILE_NAME_RE.test("noah-2"), true);
    assert.equal(CREATABLE_PROFILE_NAME_RE.test("Noah"), false);
  });

  it("the reserved-word set contains exactly the 5", () => {
    assert.equal(RESERVED_PROFILE_NAMES.size, 5);
    assert.ok(RESERVED_PROFILE_NAMES.has("hermes"));
    assert.ok(RESERVED_PROFILE_NAMES.has("sudo"));
  });
});
