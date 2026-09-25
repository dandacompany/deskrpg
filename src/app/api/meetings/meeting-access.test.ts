import assert from "node:assert/strict";
import test from "node:test";

import { canManageMeetingMinutes, resolveMeetingMinutesOwnerAccess } from "./meeting-access";

test("meeting minutes owner access allows only the channel owner", async () => {
  const ownerAccess = await resolveMeetingMinutesOwnerAccess({
    userId: "user-1",
    channelId: "channel-1",
    deps: {
      loadChannelOwner: async () => "user-1",
      loadMembership: async () => true,
    },
  });

  assert.deepEqual(ownerAccess, { ok: true });

  const memberAccess = await resolveMeetingMinutesOwnerAccess({
    userId: "user-2",
    channelId: "channel-1",
    deps: {
      loadChannelOwner: async () => "user-1",
      loadMembership: async () => true,
    },
  });

  assert.deepEqual(memberAccess, {
    ok: false,
    status: 403,
    errorCode: "not_channel_owner",
    error: "Only the channel owner can delete meeting minutes",
  });
});

test("canManageMeetingMinutes: true only for the channel owner and the meeting host", () => {
  const minutes = { initiatorId: "host" };
  assert.equal(canManageMeetingMinutes({ userId: "owner", ownerId: "owner", minutes }), true);
  assert.equal(canManageMeetingMinutes({ userId: "host", ownerId: "owner", minutes }), true);
  assert.equal(canManageMeetingMinutes({ userId: "member", ownerId: "owner", minutes }), false);
  // Minutes whose host was deleted (left) are handled only by the owner.
  assert.equal(
    canManageMeetingMinutes({ userId: "member", ownerId: "owner", minutes: { initiatorId: null } }),
    false,
  );
});
