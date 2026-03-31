import assert from "node:assert/strict";
import test from "node:test";

import { buildBootstrapActions } from "./bootstrap";

test("first user receives system admin and default group bootstrap", () => {
  const result = buildBootstrapActions({
    existingUserCount: 0,
    userId: "u-1",
    loginId: "owner",
  });

  assert.equal(result.systemRole, "system_admin");
  assert.equal(result.createDefaultGroup, true);
  assert.equal(result.defaultGroup?.name, "Default");
  assert.equal(result.defaultGroup?.slug, "default");
  assert.equal(result.groupMembership?.userId, "u-1");
  assert.equal(result.groupMembership?.role, "group_admin");
});

test("non-first users stay regular users without default group creation", () => {
  const result = buildBootstrapActions({
    existingUserCount: 3,
    userId: "u-2",
    loginId: "member",
  });

  assert.equal(result.systemRole, "user");
  assert.equal(result.createDefaultGroup, false);
  assert.equal(result.defaultGroup, undefined);
  assert.equal(result.groupMembership, null);
});
