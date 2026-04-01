import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGroupSlugCandidates,
  canChangeGroupAdminStatus,
  canWriteGroupPermissionEffect,
  deriveGroupInviteStatus,
  normalizeInviteCreationInput,
  resolveJoinRequestReview,
  resolveInviteAcceptance,
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

test("shared invite can be created without a target and without expiration", () => {
  const result = normalizeInviteCreationInput({
    targetLoginId: null,
    targetUserId: null,
    expiresAt: null,
    now: "2026-03-31T00:00:00.000Z",
  });

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("expected success");
  assert.equal(result.targetLoginId, null);
  assert.equal(result.targetUserId, null);
  assert.equal(result.expiresAt, null);
});

test("invite creation rejects past expiration timestamps", () => {
  const result = normalizeInviteCreationInput({
    targetLoginId: null,
    targetUserId: null,
    expiresAt: "2026-03-30T23:59:59.000Z",
    now: "2026-03-31T00:00:00.000Z",
  });

  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected failure");
  assert.equal(result.errorCode, "invite_expiration_invalid");
  assert.equal(result.status, 400);
});

test("expired invite status is derived before active", () => {
  assert.equal(
    deriveGroupInviteStatus({
      expiresAt: "2026-03-30T23:59:59.000Z",
      acceptedAt: null,
      revokedAt: null,
      now: "2026-03-31T00:00:00.000Z",
    }),
    "expired",
  );
});

test("targeted invite blocks a mismatched user", () => {
  const result = resolveInviteAcceptance({
    targetUserId: null,
    targetLoginId: "alice",
    acceptedAt: null,
    revokedAt: null,
    expiresAt: null,
    currentUserId: "user-2",
    currentLoginId: "bob",
    currentMembershipRole: null,
    now: "2026-03-31T00:00:00.000Z",
  });

  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected failure");
  assert.equal(result.errorCode, "group_invite_target_mismatch");
  assert.equal(result.status, 403);
});

test("shared invite accepts an ungrouped user", () => {
  const result = resolveInviteAcceptance({
    targetUserId: null,
    targetLoginId: null,
    acceptedAt: null,
    revokedAt: null,
    expiresAt: null,
    currentUserId: "user-2",
    currentLoginId: "bob",
    currentMembershipRole: null,
    now: "2026-03-31T00:00:00.000Z",
  });

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("expected success");
  assert.equal(result.shouldCreateMembership, true);
  assert.equal(result.shouldMarkAccepted, false);
});
