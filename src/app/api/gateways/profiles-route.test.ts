import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { validateProfileRegistration } from "@/app/api/gateways/[id]/profiles/validation";

describe("validateProfileRegistration", () => {
  test("accepts a well-formed registration", () => {
    const result = validateProfileRegistration({
      profileName: "sophie",
      token: "0123456789abcdef01",
    });
    assert.equal(result.ok, true);
  });

  test("rejects a token shorter than Hermes's 16-char floor", () => {
    const result = validateProfileRegistration({
      profileName: "sophie",
      token: "short",
    });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "invalid_token");
  });

  test("rejects an empty profile name", () => {
    const result = validateProfileRegistration({
      profileName: "   ",
      token: "0123456789abcdef01",
    });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "invalid_profile_name");
  });

  test("rejects a profile name with URL-unsafe characters", () => {
    const result = validateProfileRegistration({
      profileName: "so/phie",
      token: "0123456789abcdef01",
    });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "invalid_profile_name");
  });

  test("rejects a single dot, which URL-normalizes away the path segment", () => {
    const result = validateProfileRegistration({
      profileName: ".",
      token: "0123456789abcdef01",
    });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "invalid_profile_name");
  });

  test("rejects a double dot, which URL-normalizes as a traversal segment", () => {
    const result = validateProfileRegistration({
      profileName: "..",
      token: "0123456789abcdef01",
    });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "invalid_profile_name");
  });

  test("rejects a dash/underscore/dot-only name with no alphanumeric character", () => {
    const result = validateProfileRegistration({
      profileName: "-_.",
      token: "0123456789abcdef01",
    });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "invalid_profile_name");
  });

  test("accepts a legitimate name containing dots alongside alphanumerics", () => {
    const result = validateProfileRegistration({
      profileName: "my.bot-1",
      token: "0123456789abcdef01",
    });
    assert.equal(result.ok, true);
  });
});
