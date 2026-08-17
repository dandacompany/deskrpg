import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { profileStatusLabel } from "./profile-status";

describe("profileStatusLabel", () => {
  test("valid renders as ok", () => {
    assert.deepEqual(profileStatusLabel("valid"), { tone: "ok", key: "gateway.profile.status.valid" });
  });

  test("unauthorized renders as an error the operator must fix", () => {
    assert.equal(profileStatusLabel("unauthorized").tone, "error");
  });

  test("unknown_profile renders as an error", () => {
    assert.equal(profileStatusLabel("unknown_profile").tone, "error");
  });

  test("unreachable renders as a warning", () => {
    assert.equal(profileStatusLabel("unreachable").tone, "warn");
  });

  test("never-validated renders as unknown", () => {
    assert.equal(profileStatusLabel(null).tone, "unknown");
  });
});
