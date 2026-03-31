import assert from "node:assert/strict";
import test from "node:test";

import { GROUP_MEMBER_ROLES, PERMISSION_KEYS, SYSTEM_ROLES } from "./constants";
import { resolvePermission } from "./permissions";

test("rbac constants expose the initial permission vocabulary", () => {
  assert.deepEqual(PERMISSION_KEYS, [
    "create_channel",
    "manage_group_members",
    "manage_group_permissions",
    "approve_join_requests",
    "manage_group_channels",
  ]);
  assert.deepEqual(SYSTEM_ROLES, ["system_admin", "user"]);
  assert.deepEqual(GROUP_MEMBER_ROLES, ["group_admin", "member"]);
});

test("user-level deny overrides group allow", () => {
  const decision = resolvePermission({
    systemRole: "user",
    groupRole: "group_admin",
    permissionKey: "create_channel",
    groupEffects: ["allow"],
    userEffects: ["deny"],
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "user_deny");
});

test("user-level allow overrides default deny", () => {
  const decision = resolvePermission({
    systemRole: "user",
    groupRole: "member",
    permissionKey: "create_channel",
    groupEffects: [],
    userEffects: ["allow"],
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, "user_allow");
});

test("system admin gets implicit allow without explicit entries", () => {
  const decision = resolvePermission({
    systemRole: "system_admin",
    groupRole: "member",
    permissionKey: "manage_group_permissions",
    groupEffects: [],
    userEffects: [],
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, "system_role");
});

test("group admin gets implicit allow for group management permissions", () => {
  const decision = resolvePermission({
    systemRole: "user",
    groupRole: "group_admin",
    permissionKey: "approve_join_requests",
    groupEffects: [],
    userEffects: [],
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, "group_role");
});

test("group deny beats implicit group role allow when there is no user override", () => {
  const decision = resolvePermission({
    systemRole: "user",
    groupRole: "group_admin",
    permissionKey: "manage_group_channels",
    groupEffects: ["deny"],
    userEffects: [],
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "group_deny");
});

test("default deny is reported when no grants exist", () => {
  const decision = resolvePermission({
    systemRole: "user",
    groupRole: "member",
    permissionKey: "create_channel",
    groupEffects: [],
    userEffects: [],
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "default_deny");
});
