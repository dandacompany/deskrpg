import assert from "node:assert/strict";
import test from "node:test";

import { resolveChannelMemberAccess } from "./channel-membership";

test("channel member access allows the owner and members", async () => {
  const access = await resolveChannelMemberAccess({
    userId: "user-1",
    channelId: "channel-1",
    deps: {
      loadChannelOwner: async () => "user-1",
      loadMembership: async () => false,
    },
  });

  assert.deepEqual(access, { ok: true });

  const memberAccess = await resolveChannelMemberAccess({
    userId: "user-2",
    channelId: "channel-1",
    deps: {
      loadChannelOwner: async () => "user-1",
      loadMembership: async () => true,
    },
  });

  assert.deepEqual(memberAccess, { ok: true });
});

test("channel member access rejects non-members and missing channels", async () => {
  const forbidden = await resolveChannelMemberAccess({
    userId: "user-2",
    channelId: "channel-1",
    deps: {
      loadChannelOwner: async () => "user-1",
      loadMembership: async () => false,
    },
  });

  assert.deepEqual(forbidden, {
    ok: false,
    status: 403,
    errorCode: "not_a_member",
    error: "Not a member",
  });

  const missingChannel = await resolveChannelMemberAccess({
    userId: "user-2",
    channelId: "missing-channel",
    deps: {
      loadChannelOwner: async () => null,
      loadMembership: async () => false,
    },
  });

  assert.deepEqual(missingChannel, {
    ok: false,
    status: 404,
    errorCode: "channel_not_found",
    error: "Channel not found",
  });
});
