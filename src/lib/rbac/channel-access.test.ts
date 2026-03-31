import assert from "node:assert/strict";
import test from "node:test";

import { summarizeChannelJoinAccess } from "./channel-access";

test("groupless users can browse public channels but cannot join", () => {
  const result = summarizeChannelJoinAccess({
    isPublic: true,
    hasActiveGroupMembership: false,
    isChannelMember: false,
  });

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "groupless_public_browse_only");
});

test("group members can join channels", () => {
  const result = summarizeChannelJoinAccess({
    isPublic: false,
    hasActiveGroupMembership: true,
    isChannelMember: false,
  });

  assert.equal(result.allowed, true);
  assert.equal(result.reason, "group_member");
});
