import test from "node:test";
import assert from "node:assert/strict";

import { requireCapability, requireOwner, type SkillContext } from "./skill-access";

const ctx = (over: Partial<SkillContext> = {}): SkillContext => ({
  userId: "u",
  channelId: "c",
  npcId: "n",
  profileName: "sophie",
  isGatewayOwner: true,
  capabilityReady: true,
  client: {} as SkillContext["client"],
  gatewayId: "g",
  ...over,
});

test("missing capability yields 428 and the minimum version", async () => {
  const res = requireCapability(ctx({ capabilityReady: false }));
  assert.equal(res?.status, 428);
  const body = await res!.json();
  assert.equal(body.code, "plugin_upgrade_required");
  assert.equal(body.minVersion, "0.15.0");
  assert.deepEqual(body.missing, ["profile_skill_admin"]);
  assert.equal(requireCapability(ctx()), null);
});

test("a non-owner gets 403 forbidden", async () => {
  const res = requireOwner(ctx({ isGatewayOwner: false }));
  assert.equal(res?.status, 403);
  assert.equal((await res!.json()).code, "forbidden");
  assert.equal(requireOwner(ctx()), null);
});
