import { test } from "node:test";
import assert from "node:assert/strict";

import type { PluginEvent } from "@/lib/hermes/deskrpg-plugin-types";
import type { RoomMessage } from "@/lib/chat-rooms-policy";
import {
  createAutomationState,
  ingest,
  type ChannelNpcLookup,
  type IngestDeps,
} from "./automation-events";

// T6. Broadcast allowlist — an unknown kind goes out to no channel. Artifact events go out as
// `artifact:event` only for a channel NPC profile or a channel board, and delete events carry
// only `artifact_id`. Room and working indicators do not react to `artifact.*`.

const GATEWAY = "gateway-1";

type Emitted = { channelId: string; event: string; payload: unknown };

function makeDeps(opts: { npcProfiles?: string[]; boardSlug?: string } = {}) {
  const emitted: Emitted[] = [];
  const appended: Array<Parameters<IngestDeps["appendRoomMessage"]>[0]> = [];
  const npcProfiles = new Set(opts.npcProfiles ?? []);
  const deps: IngestDeps = {
    gatewayId: GATEWAY,
    boardSlug: opts.boardSlug ?? "b1",
    state: createAutomationState(),
    findNpcByProfile: async (_channelId, profileName): Promise<ChannelNpcLookup | null> =>
      npcProfiles.has(profileName)
        ? {
            profileName,
            npc: { id: `n-${profileName}`, active: true },
            displayName: profileName,
          }
        : null,
    findCronOriginChannel: async () => null,
    ensureOfficeRoomId: async () => "office-room",
    appendRoomMessage: async (args) => {
      appended.push(args);
      return {
        id: "msg-1",
        roomId: args.roomId,
        senderKind: args.senderKind,
        senderId: args.senderId,
        senderName: args.senderName,
        content: args.content,
        createdAt: new Date().toISOString(),
        notice: args.notice ?? null,
      } satisfies RoomMessage;
    },
    emitChannel: (channelId, event, payload) => emitted.push({ channelId, event, payload }),
    emitRoomMessage: () => {},
  };
  return { deps, emitted, appended };
}

let eventSeq = 0;
function ev(
  input: Partial<PluginEvent> & { kind: PluginEvent["kind"]; profile?: string; board?: string },
): PluginEvent {
  return {
    id: input.id ?? `ev_${(eventSeq += 1)}`,
    ts: input.ts ?? 1_758_000_000,
    kind: input.kind,
    board: input.board,
    task_id: input.task_id,
    profile: input.profile,
    job_id: input.job_id,
    run_id: input.run_id,
    payload: input.payload ?? {},
  };
}

test("an unknown kind is broadcast to no channel", async () => {
  const { deps, emitted } = makeDeps();
  await ingest("ch-1", [ev({ kind: "foo.bar" as never })], deps);
  assert.deepEqual(emitted, []);
});

test("artifact events go out as artifact:event only for a channel NPC profile or a channel board", async () => {
  const { deps, emitted } = makeDeps({ npcProfiles: ["sophie"], boardSlug: "b1" });
  await ingest(
    "ch-1",
    [
      ev({
        kind: "artifact.created",
        profile: "sophie",
        payload: { artifact_id: "a1", title: "보고서", profile: "sophie" },
      }),
      ev({
        kind: "artifact.created",
        profile: "other",
        board: "b1",
        payload: { artifact_id: "a2", board: "b1", profile: "other" },
      }),
      ev({
        kind: "artifact.created",
        profile: "stranger",
        payload: { artifact_id: "a3", profile: "stranger" },
      }),
    ],
    deps,
  );
  assert.deepEqual(
    emitted.map((e) => [
      e.event,
      (e.payload as { event: { payload: { artifact_id: string } } }).event.payload.artifact_id,
    ]),
    [
      ["artifact:event", "a1"],
      ["artifact:event", "a2"],
    ],
  );
  assert.equal(
    emitted.some((e) => e.event === "kanban:event"),
    false,
  );
});

test("artifact.deleted has no scope info, so it is sent carrying only artifact_id", async () => {
  const { deps, emitted } = makeDeps();
  await ingest(
    "ch-1",
    [ev({ kind: "artifact.deleted", payload: { artifact_id: "a9", deleted_by: "human:u" } })],
    deps,
  );
  assert.deepEqual(
    emitted.map((e) => (e.payload as { event: { payload: unknown } }).event.payload),
    [{ artifact_id: "a9" }],
  );
});

test("artifact events create no room notice or working indicator", async () => {
  const { deps, emitted, appended } = makeDeps({ npcProfiles: ["sophie"] });
  await ingest(
    "ch-1",
    [
      ev({
        kind: "artifact.versioned",
        profile: "sophie",
        payload: { artifact_id: "a1", profile: "sophie" },
      }),
    ],
    deps,
  );
  assert.equal(appended.length, 0);
  assert.equal(
    emitted.some((e) => e.event === "npc:working"),
    false,
  );
});
