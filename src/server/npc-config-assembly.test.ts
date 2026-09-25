import assert from "node:assert/strict";
import test from "node:test";

import { setupThrowawaySqlite, seedChannelWithProfiles } from "@/test-setup/npc-seed";

setupThrowawaySqlite("npc-config-assembly-test");

/**
 * Two contracts of `getNpcConfigsForChannel`, which assembles the meeting/free-chat participant roster.
 *
 * 1) The new hiring path leaves `agent_config` NULL (the profile is the source of truth). Assembling in
 *    that state drops the `<team-instructions>` layer entirely, so only newly created NPCs speak in
 *    meetings without the turn protocol — existing NPCs carry an old agent_config and are fine, so
 *    the symptom shows up as "only new employees act strange".
 * 2) NPCs clocked out on the roster (`active=false`) must also drop out of conversation surfaces.
 *    Unplaced ones, in contrast, stay — they are just off the map but still on duty.
 */
test("a hired NPC gets the meeting protocol even with an empty agent_config", async () => {
  const { getNpcConfigsForChannel } = await import("./socket-handlers");
  const { hireGatewayProfilesIntoChannel } = await import("@/lib/npc-roster");

  const { channelId, gatewayId } = await seedChannelWithProfiles({ profiles: 1 });
  await hireGatewayProfilesIntoChannel(channelId, gatewayId);

  const [config] = await getNpcConfigsForChannel(channelId);
  assert.ok(config, "고용된 NPC 가 명단에 있어야 한다");
  assert.match(
    config.instructions ?? "",
    /<team-instructions>/,
    "agent_config 가 NULL 이면 기본 회의 규약으로 떨어져야 한다",
  );
  // The protocol reaches the NPC only through `instructions` — a raw copy next to it would
  // disagree with it whenever the user left the protocol empty.
  assert.equal("meetingProtocol" in config, false);
});

test("dormant NPCs drop out of the conversation roster, unplaced ones stay", async () => {
  const { getNpcConfigsForChannel } = await import("./socket-handlers");
  const { selectChannelNpcs } = await import("@/lib/npc-projection");

  const { channelId } = await seedChannelWithProfiles({ unplaced: 1, dormant: 1 });
  const roster = await selectChannelNpcs(channelId, { roster: true });
  assert.equal(roster.length, 2, "출근부에는 둘 다 보인다");

  const configs = await getNpcConfigsForChannel(channelId);
  assert.deepEqual(
    configs.map((c) => c.id).sort(),
    roster
      .filter((n) => n.active)
      .map((n) => n.id)
      .sort(),
    "퇴근시킨 NPC 는 자유채팅·회의에 들어오지 않는다",
  );
  assert.equal(configs.length, 1);
});

/**
 * The response-language contract is decided by **the language at request time**. The new hiring path leaves
 * agent_config NULL, so looking only at agent_config.locale as before attached the "all speech in English"
 * contract even in a Korean office (measured on staging: only Oliver answered in English in meetings).
 */
const KO_CONTRACT = /응답 언어 계약/;
const EN_CONTRACT = /Response Language Contract/;

test("an employee without agent_config gets the Korean contract when a Korean user makes the request", async () => {
  const { getNpcConfigsForChannel } = await import("./socket-handlers");
  const { hireGatewayProfilesIntoChannel } = await import("@/lib/npc-roster");

  const { channelId, gatewayId } = await seedChannelWithProfiles({ profiles: 1 });
  await hireGatewayProfilesIntoChannel(channelId, gatewayId);

  const [config] = await getNpcConfigsForChannel(channelId, "ko");
  assert.match(config.instructions ?? "", KO_CONTRACT);
  assert.doesNotMatch(config.instructions ?? "", EN_CONTRACT);
});

test("response language fallback order: requester → agent_config.locale → en", async () => {
  const { resolveNpcInstructions } = await import("./socket-handlers");

  assert.match(resolveNpcInstructions({ locale: "en" }, "ko") ?? "", KO_CONTRACT, "요청자가 우선");
  assert.match(
    resolveNpcInstructions({ locale: "ko" }, null) ?? "",
    KO_CONTRACT,
    "요청자 없으면 직원 값",
  );
  assert.match(resolveNpcInstructions({}, null) ?? "", EN_CONTRACT, "둘 다 없을 때만 en");
});

test("an existing employee with agent_config.locale=ko stays Korean even without a request language", async () => {
  const { resolveNpcInstructions } = await import("./socket-handlers");
  assert.match(resolveNpcInstructions({ locale: "ko" }) ?? "", KO_CONTRACT);
});

test("a meeting protocol written by the user is not changed to the request language", async () => {
  const { resolveNpcInstructions } = await import("./socket-handlers");
  const out = resolveNpcInstructions({ meetingProtocol: "MY RULES" }, "ko") ?? "";
  assert.match(out, /MY RULES/);
  assert.doesNotMatch(out, KO_CONTRACT);
});

test("the meeting, 1:1 and room paths all pass the requester's language to the same resolver", async () => {
  const { readFileSync } = await import("node:fs");
  const handlers = readFileSync(new URL("./socket-handlers.ts", import.meta.url), "utf8");
  const room = readFileSync(new URL("./room-runtime.ts", import.meta.url), "utf8");

  // Both config loaders assemble through one function — no per-path protocol.
  assert.equal(handlers.match(/resolveNpcInstructions\(oc, requestLocale\)/g)?.length, 2);
  assert.equal(handlers.match(/composeNpcInstructions\(/g)?.length, 2, "해석 함수 밖 조립 없음");
  // 1:1 · free meeting chat · meeting discussion · room runtime carry the socket's language.
  assert.match(handlers, /getNpcConfig\(npcId, socketLocale\(socket\)\)/);
  assert.match(handlers, /getNpcConfigsForChannel\(channelId, socketLocale\(socket\)\)/);
  assert.match(
    handlers,
    /getOrCreateRoomRuntime\(io, room, userId, \{ locale: socketLocale\(socket\) \}\)/,
  );
  assert.match(room, /loadNpcConfigs\(room\.channelId, deps\.locale\)/);
});

test("the JSON registration instruction from old conversations is retired and points to the current confirm screen", async () => {
  const { resolveNpcInstructions } = await import("./socket-handlers");
  for (const config of [{}, { meetingProtocol: "사용자 회의 규칙" }]) {
    const out = resolveNpcInstructions(config, "ko") ?? "";
    assert.match(out, /json:task/);
    assert.match(out, /카드로 등록/);
    assert.match(out, /폐기/);
    assert.match(out, /Hermes/);
  }
});

test("the task-registration layer follows the same language as the protocol, including for a user-written protocol", async () => {
  const { resolveNpcInstructions } = await import("./socket-handlers");
  const KO_TASK = /등록 지시는 폐기됐다/;
  const EN_TASK = /registration instructions in past conversations are retired/;

  assert.match(resolveNpcInstructions({}, "ko") ?? "", KO_TASK);
  assert.match(resolveNpcInstructions({}, "ja") ?? "", EN_TASK);
  assert.match(resolveNpcInstructions({ locale: "ko" }, null) ?? "", KO_TASK, "employee value");
  assert.match(resolveNpcInstructions({}, null) ?? "", EN_TASK, "nothing known → en");
  assert.match(resolveNpcInstructions({ meetingProtocol: "MY RULES" }, "ko") ?? "", KO_TASK);
  assert.match(resolveNpcInstructions({ meetingProtocol: "MY RULES" }, "en") ?? "", EN_TASK);
  assert.match(resolveNpcInstructions({ meetingProtocol: "MY RULES" }) ?? "", EN_TASK);
});
