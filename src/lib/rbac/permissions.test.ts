import assert from "node:assert/strict";
import test from "node:test";

import { GROUP_MEMBER_ROLES, PERMISSION_KEYS, SYSTEM_ROLES } from "./constants";

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
