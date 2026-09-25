import "../../test-setup/dom";

import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { ToolApprovalsProvider } from "@/components/approvals/ToolApprovalsProvider";
import type { ToolApprovalSocket } from "@/components/approvals/use-tool-approvals";
import type { RoomSummary } from "@/lib/chat-rooms-policy";
import { I18nProvider } from "@/lib/i18n";
import { TOOL_APPROVAL_EVENTS } from "@/lib/tool-approval-types";
import WorkspaceNavigator from "./WorkspaceNavigator";

class FakeSocket implements ToolApprovalSocket {
  handlers = new Map<string, Set<(payload: unknown) => void>>();
  on(event: string, handler: (payload: unknown) => void) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
    return this;
  }
  off(event: string, handler: (payload: unknown) => void) {
    this.handlers.get(event)?.delete(handler);
    return this;
  }
  emit() {
    return this;
  }
  async fire(event: string, payload: unknown) {
    await act(async () => {
      for (const h of this.handlers.get(event) ?? []) h(payload);
    });
  }
}

const room = (id: string, name: string): RoomSummary => ({
  id,
  kind: id === "office" ? "office" : "group",
  name,
  replyPolicy: "mention",
  createdBy: "owner",
  lastMessageAt: null,
  members: [],
});
const rooms = [room("office", "출판사"), room("design", "디자인 리뷰")];

async function mount(socket: FakeSocket) {
  const element = document.createElement("div");
  document.body.appendChild(element);
  const root = createRoot(element);
  const render = (currentRoomId: string | null) =>
    act(async () => {
      root.render(
        <I18nProvider initialLocale="ko">
          <ToolApprovalsProvider socket={socket}>
            <WorkspaceNavigator
              workspaceName="출판사"
              rooms={rooms}
              currentRoomId={currentRoomId}
              players={[]}
              npcs={[]}
              isOwner
              onSelectRoom={() => {}}
              onSelectNpc={() => {}}
              onSelectPlayer={() => {}}
              onCompose={() => {}}
              onNpcAction={() => {}}
            />
          </ToolApprovalsProvider>
        </I18nProvider>,
      );
    });
  return {
    element,
    render,
    unmount: async () => {
      await act(async () => root.unmount());
      element.remove();
    },
  };
}

const badge = (element: HTMLElement, roomId: string) =>
  element.querySelector(`[data-room-approvals="${roomId}"]`);

test("a room approval waiting while another view is open shows a badge on that room, gone once it is open", async () => {
  const socket = new FakeSocket();
  const view = await mount(socket);
  try {
    await view.render(null); // a DM is open — no room is current
    assert.equal(badge(view.element, "design"), null);
    await socket.fire(TOOL_APPROVAL_EVENTS.request, {
      key: "run:1",
      runId: "run",
      requestId: "1",
      npcId: "sophie",
      channelId: "c1",
      context: "room",
      roomId: "design",
      kind: "command",
      command: "rm -r /tmp/x",
      description: "",
      choices: ["once", "deny"],
      expiresAt: Date.now() + 120_000,
    });
    assert.match(badge(view.element, "design")?.textContent ?? "", /승인 대기 1/);
    assert.equal(badge(view.element, "office"), null);

    await view.render("design");
    assert.equal(badge(view.element, "design"), null, "the open room shows the card itself");

    await view.render("office");
    assert.ok(badge(view.element, "design"));
    await socket.fire(TOOL_APPROVAL_EVENTS.resolved, { key: "run:1", status: "denied" });
    assert.equal(badge(view.element, "design"), null);
  } finally {
    await view.unmount();
  }
});
