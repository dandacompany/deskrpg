import assert from "node:assert/strict";
import test from "node:test";

import {
  summarizeChannelCreateAccess,
  summarizeChannelDetailAccess,
  summarizeChannelJoinAccess,
} from "./channel-access";

test("non-member cannot create a channel even with a would-be allow", () => {
  const result = summarizeChannelCreateAccess({
    hasActiveGroupMembership: false,
    permissionAllowed: true,
  });

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "group_membership_required");
});

test("groupless users can browse grouped public channels but cannot join", () => {
  const result = summarizeChannelJoinAccess({
    groupId: "group-1",
    isPublic: true,
    hasActiveGroupMembership: false,
  });

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "groupless_public_browse_only");
});

test("existing channel membership does not bypass missing active group membership", () => {
  const result = summarizeChannelJoinAccess({
    groupId: "group-1",
    isPublic: false,
    hasActiveGroupMembership: false,
  });

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "group_membership_required");
});

test("group members can join grouped channels", () => {
  const result = summarizeChannelJoinAccess({
    groupId: "group-1",
    isPublic: false,
    hasActiveGroupMembership: true,
  });

  assert.equal(result.allowed, true);
  assert.equal(result.reason, "group_member");
});

test("private detail access distinguishes password-needed from membership-needed", () => {
  const missingMembership = summarizeChannelDetailAccess({
    groupId: "group-1",
    isPublic: false,
    hasActiveGroupMembership: false,
    isChannelMember: false,
  });
  const passwordNeeded = summarizeChannelDetailAccess({
    groupId: "group-1",
    isPublic: false,
    hasActiveGroupMembership: true,
    isChannelMember: false,
  });

  assert.equal(missingMembership.allowed, false);
  assert.equal(missingMembership.reason, "group_membership_required");
  assert.equal(missingMembership.requiresPassword, false);

  assert.equal(passwordNeeded.allowed, true);
  assert.equal(passwordNeeded.reason, "group_member");
  assert.equal(passwordNeeded.requiresPassword, true);
});

test("null-group channels fall back to legacy public access", () => {
  const detail = summarizeChannelDetailAccess({
    groupId: null,
    isPublic: true,
    hasActiveGroupMembership: false,
    isChannelMember: false,
  });
  const join = summarizeChannelJoinAccess({
    groupId: null,
    isPublic: true,
    hasActiveGroupMembership: false,
  });

  assert.equal(detail.allowed, true);
  assert.equal(detail.reason, "legacy_public_channel");
  assert.equal(join.allowed, true);
  assert.equal(join.reason, "legacy_public_channel");
});

test("null-group private channels fall back to legacy password flow", () => {
  const detail = summarizeChannelDetailAccess({
    groupId: null,
    isPublic: false,
    hasActiveGroupMembership: false,
    isChannelMember: false,
  });
  const join = summarizeChannelJoinAccess({
    groupId: null,
    isPublic: false,
    hasActiveGroupMembership: false,
  });

  assert.equal(detail.allowed, false);
  assert.equal(detail.reason, "legacy_private_password_required");
  assert.equal(detail.requiresPassword, true);
  assert.equal(join.allowed, true);
  assert.equal(join.reason, "legacy_private_channel");
});
