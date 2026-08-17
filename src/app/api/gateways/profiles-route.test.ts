import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { validateProfileRegistration } from "@/app/api/gateways/[id]/profiles/validation";

describe("validateProfileRegistration", () => {
  test("accepts a well-formed registration", () => {
    const result = validateProfileRegistration({ profileName: "sophie", token: "0123456789abcdef01" });
    assert.equal(result.ok, true);
  });

  test("rejects a token shorter than Hermes's 16-char floor", () => {
    const result = validateProfileRegistration({ profileName: "sophie", token: "short" });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "invalid_token");
  });

  test("rejects an empty profile name", () => {
    const result = validateProfileRegistration({ profileName: "   ", token: "0123456789abcdef01" });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "invalid_profile_name");
  });

  test("rejects a profile name with URL-unsafe characters", () => {
    const result = validateProfileRegistration({ profileName: "so/phie", token: "0123456789abcdef01" });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "invalid_profile_name");
  });
});
