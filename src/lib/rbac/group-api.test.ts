import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGroupSlugCandidates,
  canChangeGroupAdminStatus,
  canWriteGroupPermissionEffect,
  resolveJoinRequestReview,
  sanitizeGroupPermissionEffects,
  summarizeGroupManagementCapabilities,
} from "./group-api";

test("manage_group_permissions deny writes are rejected to prevent self-lock", () => {
  assert.equal(
    canWriteGroupPermissionEffect({
      permissionKey: "manage_group_permissions",
      effect: "deny",
    }),
    false,
  );
  assert.equal(
    canWriteGroupPermissionEffect({
      permissionKey: "manage_group_permissions",
      effect: "allow",
    }),
    true,
  );
  assert.equal(
    canWriteGroupPermissionEffect({
      permissionKey: "create_channel",
      effect: "deny",
    }),
    true,
  );
});

test("stale manage_group_permissions deny effects are ignored at authorization time", () => {
  assert.deepEqual(
    sanitizeGroupPermissionEffects({
      permissionKey: "manage_group_permissions",
      effects: ["deny", "allow"],
    }),
    ["allow"],
  );
  assert.deepEqual(
    sanitizeGroupPermissionEffects({
      permissionKey: "create_channel",
      effects: ["deny", "allow"],
    }),
    ["deny", "allow"],
  );
});

test("join-request review rejects replay on non-pending requests", () => {
  const result = resolveJoinRequestReview({
    currentStatus: "approved",
    action: "reject",
    existingMembershipRole: null,
  });

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "forbidden");
  assert.equal(result.status, 409);
});

test("join-request approval preserves existing elevated membership role", () => {
  const result = resolveJoinRequestReview({
    currentStatus: "pending",
    action: "approve",
    existingMembershipRole: "group_admin",
  });

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("expected ok result");
  assert.equal(result.nextStatus, "approved");
  assert.equal(result.shouldUpsertMembership, false);
  assert.equal(result.preservedMembershipRole, "group_admin");
});

test("join-request approval creates member role when no membership exists", () => {
  const result = resolveJoinRequestReview({
    currentStatus: "pending",
    action: "approve",
    existingMembershipRole: null,
  });

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("expected ok result");
  assert.equal(result.nextStatus, "approved");
  assert.equal(result.shouldUpsertMembership, true);
  assert.equal(result.membershipRole, "member");
});

test("group slug candidates provide deterministic retry sequence", () => {
  assert.deepEqual(buildGroupSlugCandidates("team", 4), [
    "team",
    "team-2",
    "team-3",
    "team-4",
  ]);
});

test("management capabilities derive a single canManageGroup flag", () => {
  assert.deepEqual(
    summarizeGroupManagementCapabilities({
      canCreateChannel: false,
      canManageMembers: false,
      canManagePermissions: true,
      canApproveJoinRequests: false,
    }),
    {
      canCreateChannel: false,
      canManageMembers: false,
      canManagePermissions: true,
      canApproveJoinRequests: false,
      canManageGroup: true,
    },
  );
});

test("last group admin cannot be demoted or removed", () => {
  const result = canChangeGroupAdminStatus({
    targetUserId: "user-1",
    targetCurrentRole: "group_admin",
    nextRole: "member",
    adminUserIds: ["user-1"],
  });

  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected failure");
  assert.equal(result.errorCode, "last_group_admin_required");
  assert.equal(result.status, 409);
});

test("group admin changes are allowed when another admin remains", () => {
  const result = canChangeGroupAdminStatus({
    targetUserId: "user-1",
    targetCurrentRole: "group_admin",
    nextRole: null,
    adminUserIds: ["user-1", "user-2"],
  });

  assert.equal(result.ok, true);
});
