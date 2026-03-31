import assert from "node:assert/strict";
import test from "node:test";

import {
  buildChannelAccessDeniedPayload,
  getChannelAccessDeniedErrorCode,
  summarizeChannelCreateAccess,
  summarizeChannelDetailAccess,
  summarizeChannelJoinAccess,
  summarizeChannelParticipationAccess,
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

test("socket participation denies grouped public browse-only users", () => {
  const result = summarizeChannelParticipationAccess({
    groupId: "group-1",
    isPublic: true,
    hasActiveGroupMembership: false,
    isChannelMember: false,
  });

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "groupless_public_browse_only");
});

test("socket participation requires active group membership even for existing channel members", () => {
  const result = summarizeChannelParticipationAccess({
    groupId: "group-1",
    isPublic: false,
    hasActiveGroupMembership: false,
    isChannelMember: true,
  });

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "group_membership_required");
});

test("socket participation requires prior private-channel approval after group membership", () => {
  const result = summarizeChannelParticipationAccess({
    groupId: "group-1",
    isPublic: false,
    hasActiveGroupMembership: true,
    isChannelMember: false,
  });

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "password_required");
});

test("socket participation allows active members into grouped channels", () => {
  const result = summarizeChannelParticipationAccess({
    groupId: "group-1",
    isPublic: false,
    hasActiveGroupMembership: true,
    isChannelMember: true,
  });

  assert.equal(result.allowed, true);
  assert.equal(result.reason, "group_member");
});

test("socket participation preserves legacy null-group fallback", () => {
  const publicChannel = summarizeChannelParticipationAccess({
    groupId: null,
    isPublic: true,
    hasActiveGroupMembership: false,
    isChannelMember: false,
  });
  const privateMember = summarizeChannelParticipationAccess({
    groupId: null,
    isPublic: false,
    hasActiveGroupMembership: false,
    isChannelMember: true,
  });
  const privateNonMember = summarizeChannelParticipationAccess({
    groupId: null,
    isPublic: false,
    hasActiveGroupMembership: false,
    isChannelMember: false,
  });

  assert.equal(publicChannel.allowed, true);
  assert.equal(publicChannel.reason, "legacy_public_channel");
  assert.equal(privateMember.allowed, true);
  assert.equal(privateMember.reason, "legacy_channel_member");
  assert.equal(privateNonMember.allowed, false);
  assert.equal(privateNonMember.reason, "legacy_private_password_required");
});

test("socket denial reasons map to stable localized error codes", () => {
  assert.equal(
    getChannelAccessDeniedErrorCode("groupless_public_browse_only"),
    "public_channel_browse_only",
  );
  assert.equal(
    getChannelAccessDeniedErrorCode("group_membership_required"),
    "group_membership_required",
  );
  assert.equal(
    getChannelAccessDeniedErrorCode("password_required"),
    "password_required",
  );
  assert.equal(
    getChannelAccessDeniedErrorCode("legacy_private_password_required"),
    "password_required",
  );
});

test("socket denial payload preserves reason and specific errorCode", () => {
  const payload = buildChannelAccessDeniedPayload({
    channelId: "channel-1",
    action: "meeting:join",
    reason: "legacy_private_password_required",
  });

  assert.deepEqual(payload, {
    channelId: "channel-1",
    action: "meeting:join",
    reason: "legacy_private_password_required",
    errorCode: "password_required",
  });
});
