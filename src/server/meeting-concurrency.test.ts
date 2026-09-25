import assert from "node:assert/strict";
import test from "node:test";

import { AdapterRegistry } from "../lib/adapters/types";
import { defaultCreateMeetingBroker } from "./meeting-discussion";

// A meeting poll asks every participant at once, in chunks no larger than the gateway's
// max_concurrent_runs — the same Hermes api_server serves them, and runs past that limit queue.

type BrokerConfig = Parameters<typeof defaultCreateMeetingBroker>[0];

function hermesNpc(id: string) {
  return {
    id,
    name: id,
    agentId: null,
    sessionKeyPrefix: `sess-${id}`,
    adapterType: "hermes",
    hermesProfileId: `profile-${id}`,
    role: "Participant",
    passPolicy: null,
  };
}

/** Adapters that PASS after a tick and record how many polls were in flight at once. */
function concurrencyProbe() {
  let inFlight = 0;
  let peak = 0;
  const create = async () => ({
    type: "hermes",
    async execute(options: { sessionKey: string }) {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return { response: "PASS", session: { sessionRef: options.sessionKey } };
    },
    async testConnection() {
      return { status: "ok" as const };
    },
  });
  return { create, peak: () => peak };
}

async function runMeeting(readMaxConcurrentRuns: (npcId: string) => Promise<number>) {
  const probe = concurrencyProbe();
  const asked: string[] = [];
  const broker = await defaultCreateMeetingBroker(
    {
      topic: "Roadmap",
      npcs: ["a", "b", "c", "d", "e", "f"].map(hermesNpc),
      userId: "u1",
      channelId: "c1",
      adapterRegistry: new AdapterRegistry(),
      sessionKeyPrefix: "sess",
      meetingId: "meet-1",
      settings: {},
      quota: { maxTotalTurns: 2 },
      locale: "en",
    } as unknown as BrokerConfig,
    {},
    {
      createHermesAdapter: probe.create as never,
      readMaxConcurrentRuns: async (npcId) => {
        asked.push(npcId);
        return readMaxConcurrentRuns(npcId);
      },
    },
  );
  await broker.run();
  return { peak: probe.peak(), asked };
}

test("a meeting polls no more participants at once than the gateway's max_concurrent_runs", async () => {
  const { peak, asked } = await runMeeting(async () => 2);

  assert.equal(peak, 2);
  assert.deepEqual(asked, ["a"], "the gateway is asked once per meeting");
});

test("a gateway allowing more runs lets more participants poll at once", async () => {
  assert.equal((await runMeeting(async () => 6)).peak, 6);
});

test("an unreadable limit falls back to four and does not stop the meeting", async () => {
  const { peak } = await runMeeting(async () => {
    throw new Error("capabilities unreachable");
  });

  assert.equal(peak, 4);
});
