import assert from "node:assert/strict";
import test from "node:test";
import { act, useState } from "react";

import {
  TOOL_APPROVAL_EVENTS,
  type ToolApprovalChoice,
  type ToolApprovalRequest,
} from "@/lib/tool-approval-types";

import { $, cleanup, click, container, flush, render, text } from "../skills/skills-test-harness";
import ToolApprovalStack, { formatRemaining } from "./ToolApprovalCard";
import { ToolApprovalsProvider } from "./ToolApprovalsProvider";
import type { ToolApprovalSocket } from "./use-tool-approvals";

class FakeSocket implements ToolApprovalSocket {
  handlers = new Map<string, Set<(payload: unknown) => void>>();
  emitted: [string, unknown][] = [];
  on(event: string, handler: (payload: unknown) => void) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
    return this;
  }
  off(event: string, handler: (payload: unknown) => void) {
    this.handlers.get(event)?.delete(handler);
    return this;
  }
  acks: Array<(reply: unknown) => void> = [];
  emit(event: string, payload: unknown, ack?: (reply: unknown) => void) {
    this.emitted.push([event, payload]);
    if (ack) this.acks.push(ack);
    return this;
  }
  async fire(event: string, payload: unknown) {
    await act(async () => {
      for (const h of this.handlers.get(event) ?? []) h(payload);
    });
    await flush();
  }
  count() {
    return [...this.handlers.values()].reduce((n, set) => n + set.size, 0);
  }
}

const request = (over: Partial<ToolApprovalRequest> = {}): ToolApprovalRequest => ({
  key: "run-1:req-1",
  runId: "run-1",
  requestId: "req-1",
  npcId: "n1",
  channelId: "c1",
  context: "dm",
  kind: "command",
  command: "rm -r /tmp/probe",
  description: "recursive delete",
  choices: ["once", "session", "deny"],
  expiresAt: Date.now() + 120_000,
  ...over,
});

const names = { n1: "소피", n2: "Max" };

const dm = (socket: FakeSocket, over: Record<string, unknown> = {}) => (
  <ToolApprovalStack
    socket={socket}
    channelId="c1"
    context="dm"
    npcId="n1"
    npcNames={names}
    collapseMs={30}
    {...over}
  />
);

test.afterEach(cleanup);

test("a request shows who wants to run what, with once/session/deny in order and never always", async () => {
  const socket = new FakeSocket();
  await render(dm(socket));
  await socket.fire(TOOL_APPROVAL_EVENTS.request, {
    ...request(),
    choices: ["once", "session", "always", "deny"] as unknown as ToolApprovalChoice[],
  });
  assert.match(text(), /소피/);
  assert.equal($("[data-approval-command]").textContent, "rm -r /tmp/probe");
  const buttons = [...container.querySelectorAll("[data-choice]")].map((b) =>
    b.getAttribute("data-choice"),
  );
  assert.deepEqual(buttons, ["once", "session", "deny"]);
  assert.match(text(), /한 번 허용/);
  assert.match(text(), /이번 답변 동안 허용/);
  assert.match(text(), /거절/);
});

test("an MCP request is labelled as a tool call, and a request without session hides that button", async () => {
  const socket = new FakeSocket();
  await render(dm(socket));
  await socket.fire(
    TOOL_APPROVAL_EVENTS.request,
    request({ kind: "mcp", choices: ["once", "deny"] }),
  );
  assert.match(text(), /MCP 도구 호출/);
  assert.ok(!container.querySelector("[data-choice=session]"));
});

test("clicking a choice emits decide, locks the buttons, and the resolution replaces them then folds away", async () => {
  const socket = new FakeSocket();
  // Long enough that a loaded test run still sees the result before the card folds.
  await render(dm(socket, { collapseMs: 1_000 }));
  await socket.fire(TOOL_APPROVAL_EVENTS.request, request());
  await click("[data-choice=once]");
  assert.deepEqual(socket.emitted, [
    [TOOL_APPROVAL_EVENTS.decide, { key: "run-1:req-1", choice: "once" }],
  ]);
  assert.equal(($("[data-choice=deny]") as HTMLButtonElement).disabled, true);
  await socket.fire(TOOL_APPROVAL_EVENTS.resolved, { key: "run-1:req-1", status: "approved_once" });
  assert.ok(!container.querySelector("[data-choice]"));
  assert.match(text(), /한 번 허용했습니다/);
  await new Promise((r) => setTimeout(r, 1_100));
  await flush();
  assert.ok(!container.querySelector("[data-testid=tool-approval-card]"));
});

test("a refused decision (not the approver) unlocks the buttons again", async () => {
  const socket = new FakeSocket();
  await render(dm(socket));
  await socket.fire(TOOL_APPROVAL_EVENTS.request, request());
  await click("[data-choice=once]");
  assert.equal(($("[data-choice=deny]") as HTMLButtonElement).disabled, true);
  await act(async () => socket.acks[0]({ result: "not_approver" }));
  await flush();
  assert.equal(($("[data-choice=deny]") as HTMLButtonElement).disabled, false);
});

test("the countdown runs out into a timeout with no buttons", async () => {
  const socket = new FakeSocket();
  await render(dm(socket, { collapseMs: 60_000 }));
  await socket.fire(TOOL_APPROVAL_EVENTS.request, request({ expiresAt: Date.now() + 1_200 }));
  assert.match($("[data-approval-remaining]").textContent ?? "", /0:0[12]/);
  await new Promise((r) => setTimeout(r, 2_100));
  await flush();
  assert.ok(!container.querySelector("[data-choice]"));
  assert.equal($("[data-testid=tool-approval-card]").getAttribute("data-status"), "expired");
  assert.match(text(), /시간 초과/);
});

test("two requests in one run are resolved independently", async () => {
  const socket = new FakeSocket();
  await render(dm(socket, { collapseMs: 60_000 }));
  await socket.fire(TOOL_APPROVAL_EVENTS.request, request());
  await socket.fire(
    TOOL_APPROVAL_EVENTS.request,
    request({ key: "run-1:req-2", requestId: "req-2", command: "rm -r /tmp/other" }),
  );
  await socket.fire(TOOL_APPROVAL_EVENTS.resolved, { key: "run-1:req-1", status: "denied" });
  const cards = [...container.querySelectorAll("[data-testid=tool-approval-card]")];
  assert.deepEqual(
    cards.map((c) => c.getAttribute("data-status")),
    ["denied", "pending"],
  );
  assert.ok(cards[1].querySelector("[data-choice=once]"));
});

test("a DM stack shows only its NPC and channel, and a repeated request does not duplicate", async () => {
  const socket = new FakeSocket();
  await render(dm(socket));
  await socket.fire(TOOL_APPROVAL_EVENTS.request, request({ key: "a:1", npcId: "n2" }));
  await socket.fire(TOOL_APPROVAL_EVENTS.request, request({ key: "b:1", channelId: "c2" }));
  await socket.fire(TOOL_APPROVAL_EVENTS.request, request({ key: "m:1", context: "meeting" }));
  assert.equal(container.querySelectorAll("[data-testid=tool-approval-card]").length, 0);
  await socket.fire(TOOL_APPROVAL_EVENTS.request, request());
  await socket.fire(TOOL_APPROVAL_EVENTS.request, request());
  assert.equal(container.querySelectorAll("[data-testid=tool-approval-card]").length, 1);
});

test("meeting participants see a waiting line until it clears; the approver sees the card instead", async () => {
  const socket = new FakeSocket();
  await render(
    <ToolApprovalStack socket={socket} channelId="c1" context="meeting" npcNames={names} />,
  );
  await socket.fire(TOOL_APPROVAL_EVENTS.pending, {
    key: "r:1",
    npcId: "n2",
    approverName: "단테",
  });
  assert.match($("[data-approval-pending]").textContent ?? "", /Max.*단테/);
  assert.ok(!container.querySelector("[data-choice]"));
  await socket.fire(TOOL_APPROVAL_EVENTS.pending, { key: "r:1", cleared: true });
  assert.ok(!container.querySelector("[data-approval-pending]"));

  await socket.fire(TOOL_APPROVAL_EVENTS.pending, {
    key: "r:2",
    npcId: "n1",
    approverName: "단테",
  });
  await socket.fire(TOOL_APPROVAL_EVENTS.request, request({ key: "r:2", context: "meeting" }));
  assert.ok(!container.querySelector("[data-approval-pending]"));
  assert.ok($("[data-choice=once]"));
});

test("under the page provider, a room card that arrived while another chat was shown is still there", async () => {
  const socket = new FakeSocket();
  function Page() {
    const [room, setRoom] = useState(false);
    // Different keys: the room stack is a fresh mount, as it is in the chat panel.
    return room ? (
      <ToolApprovalStack
        key="room"
        socket={socket}
        channelId="c1"
        context="room"
        roomId="room-1"
        npcNames={names}
      />
    ) : (
      <div key="dm">
        <button data-open-room onClick={() => setRoom(true)} />
        {dm(socket)}
      </div>
    );
  }
  await render(
    <ToolApprovalsProvider socket={socket}>
      <Page />
    </ToolApprovalsProvider>,
  );
  // The DM of the same NPC is open; the room turn's request arrives now.
  await socket.fire(
    TOOL_APPROVAL_EVENTS.request,
    request({ key: "r:room", context: "room", roomId: "room-1" }),
  );
  assert.ok(!container.querySelector("[data-choice]"), "a DM does not show a room card");
  await click("[data-open-room]");
  assert.ok($("[data-choice=once]"), "switching to the room shows the card");
  await click("[data-choice=once]");
  assert.deepEqual(socket.emitted.at(-1), [
    TOOL_APPROVAL_EVENTS.decide,
    { key: "r:room", choice: "once" },
  ]);
});

test("unmounting unsubscribes from the socket", async () => {
  const socket = new FakeSocket();
  await render(dm(socket));
  assert.ok(socket.count() > 0);
  await cleanup();
  assert.equal(socket.count(), 0);
});

test("remaining time is m:ss", () => {
  assert.equal(formatRemaining(0), "0:00");
  assert.equal(formatRemaining(61_000), "1:01");
  assert.equal(formatRemaining(299_400), "5:00");
});

test("a chat room shows only its own cards and waiting lines", async () => {
  const socket = new FakeSocket();
  await render(
    <ToolApprovalStack
      socket={socket}
      channelId="c1"
      context="room"
      roomId="room-a"
      npcNames={names}
    />,
  );
  await socket.fire(
    TOOL_APPROVAL_EVENTS.request,
    request({ key: "x:1", context: "room", roomId: "room-b" }),
  );
  await socket.fire(TOOL_APPROVAL_EVENTS.request, request({ key: "x:2", context: "meeting" }));
  assert.equal(container.querySelectorAll("[data-testid=tool-approval-card]").length, 0);
  await socket.fire(
    TOOL_APPROVAL_EVENTS.request,
    request({ key: "x:3", context: "room", roomId: "room-a" }),
  );
  assert.equal(container.querySelectorAll("[data-testid=tool-approval-card]").length, 1);

  await socket.fire(TOOL_APPROVAL_EVENTS.pending, {
    key: "w:1",
    npcId: "n2",
    approverName: "단테",
    roomId: "room-b",
  });
  await socket.fire(TOOL_APPROVAL_EVENTS.pending, {
    key: "w:2",
    npcId: "n2",
    approverName: "단테",
  });
  assert.ok(!container.querySelector("[data-approval-pending]"));
  await socket.fire(TOOL_APPROVAL_EVENTS.pending, {
    key: "w:3",
    npcId: "n2",
    approverName: "단테",
    roomId: "room-a",
  });
  assert.match($("[data-approval-pending]").textContent ?? "", /Max.*단테/);
});

test("a meeting stack ignores a chat room's waiting line", async () => {
  const meetingSocket = new FakeSocket();
  await render(
    <ToolApprovalStack socket={meetingSocket} channelId="c1" context="meeting" npcNames={names} />,
  );
  await meetingSocket.fire(TOOL_APPROVAL_EVENTS.pending, {
    key: "w:4",
    npcId: "n2",
    approverName: "단테",
    roomId: "room-a",
  });
  assert.ok(!container.querySelector("[data-approval-pending]"));
});
