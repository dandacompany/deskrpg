import assert from "node:assert/strict";
import test from "node:test";

import type { ToolApprovalRequest } from "@/lib/tool-approval-types";

import {
  pendingApprovalsByNpc,
  pendingApprovalsByRoom,
  type ApprovalCardState,
} from "./use-tool-approvals";

const NOW = 1_000_000;

const card = (
  key: string,
  over: Partial<ToolApprovalRequest> = {},
  status: ApprovalCardState["status"] = "pending",
): ApprovalCardState => ({
  request: {
    key,
    runId: key,
    requestId: null,
    npcId: "n1",
    channelId: "c1",
    context: "room",
    roomId: "r1",
    kind: "command",
    command: "ls",
    description: "",
    choices: ["once", "deny"],
    expiresAt: NOW + 60_000,
    groupKey: "g-1",
    repeat: { count: 1, lastStatus: null },
    summary: { state: "unavailable" },
    ...over,
  },
  status,
  deciding: false,
});

test("counts pending room approvals per room, cards and other people's waiting lines together", () => {
  const counts = pendingApprovalsByRoom(
    [card("a"), card("b", { roomId: "r2" }), card("c")],
    [{ key: "w", npcId: "n2", approverName: "단테", roomId: "r2" }],
    NOW,
  );
  assert.deepEqual(counts, { r1: 2, r2: 2 });
});

test("resolved, expired, DM and meeting approvals are not counted", () => {
  const counts = pendingApprovalsByRoom(
    [
      card("done", {}, "approved_once"),
      card("late", { expiresAt: NOW - 1 }),
      card("dm", { context: "dm", roomId: undefined }),
      card("meeting", { context: "meeting", roomId: undefined }),
    ],
    [{ key: "m", npcId: "n2", approverName: "단테" }],
    NOW,
  );
  assert.deepEqual(counts, {});
});

test("a waiting line that has its own card is counted once", () => {
  const counts = pendingApprovalsByRoom(
    [card("same")],
    [{ key: "same", npcId: "n1", approverName: "단테", roomId: "r1" }],
    NOW,
  );
  assert.deepEqual(counts, { r1: 1 });
});

test("counts pending approvals per employee across DMs, meetings and rooms", () => {
  const counts = pendingApprovalsByNpc(
    [
      card("a", { context: "dm", roomId: undefined }),
      card("b", { context: "meeting", roomId: undefined }),
      card("c", { npcId: "n2" }),
      card("d", {}, "approved_once"),
      card("e", { expiresAt: NOW - 1 }),
    ],
    [
      { key: "w", npcId: "n2", approverName: "someone" },
      { key: "a", npcId: "n1", approverName: "someone" },
    ],
    NOW,
  );
  assert.deepEqual(counts, { n1: 2, n2: 2 });
});
