import assert from "node:assert/strict";
import test from "node:test";

import type { CronDeliveryTarget } from "@/lib/hermes/deskrpg-plugin-types";

import { deliverRows } from "./deliver-targets";

// Hermes lists one "Bot Chat (<profile>)" target per profile on the whole gateway. A channel should
// only offer its own employees, by the name the user knows them by.

const target = (id: string, name: string, homeSet = true): CronDeliveryTarget => ({
  id,
  name,
  home_target_set: homeSet,
  home_env_var: "",
});

const GATEWAY_TARGETS = [
  target("local", "Local"),
  target("telegram", "Telegram", false),
  target("bot-chat:default", "Bot Chat (default)"),
  target("bot-chat:sophie", "Bot Chat (sophie)"),
  target("bot-chat:mia", "Bot Chat (mia)"),
  target("bot-chat:oliver", "Bot Chat (oliver)"),
];
const CHANNEL = [
  { profileName: "sophie", npcName: "소피" },
  { profileName: "oliver", npcName: "올리버" },
];

test("only this channel's employees are offered as bot-chat targets, named as the user knows them", () => {
  const rows = deliverRows(GATEWAY_TARGETS, ["local"], CHANNEL);
  assert.deepEqual(
    rows.map((r) => [r.id, r.kind, r.npcName ?? null]),
    [
      ["local", "local", null],
      ["telegram", "platform", null],
      ["bot-chat:sophie", "botChat", "소피"],
      ["bot-chat:oliver", "botChat", "올리버"],
    ],
  );
  assert.equal(rows[1].target?.home_target_set, false);
});

test("a target the job already uses stays visible so it can be unchecked", () => {
  const rows = deliverRows(GATEWAY_TARGETS, ["bot-chat:mia", "slack"], CHANNEL);
  const ids = rows.map((r) => r.id);
  assert.ok(ids.includes("bot-chat:mia"));
  assert.ok(ids.includes("slack"));
  assert.equal(rows.find((r) => r.id === "bot-chat:mia")?.profileName, "mia");
});

test("without the channel's profiles, every bot-chat target is kept with its profile name", () => {
  const rows = deliverRows(GATEWAY_TARGETS, ["local"]);
  assert.deepEqual(
    rows.filter((r) => r.kind === "botChat").map((r) => r.profileName),
    ["default", "sophie", "mia", "oliver"],
  );
});
