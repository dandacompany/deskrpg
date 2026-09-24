import "../../test-setup/dom";

import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "@/lib/i18n";
import MeetingWorkspace from "./MeetingWorkspace";
import { EventBus } from "@/game/EventBus";
import { fireEvent } from "@testing-library/dom";

globalThis.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
} as typeof ResizeObserver;

test("meeting workspace keeps the existing meeting controls inside a labelled surface", async () => {
  const element = document.createElement("div");
  document.body.appendChild(element);
  const root = createRoot(element);
  await act(async () => {
    root.render(
      <I18nProvider initialLocale="ko">
        <MeetingWorkspace
          channelId="channel"
          character={{
            id: "user",
            name: "은채",
            appearance: { gender: "female", body: "female" } as never,
          }}
          socket={null}
          npcs={[]}
          onLeave={() => {}}
        />
      </I18nProvider>,
    );
  });

  const surface = element.querySelector("[data-meeting-workspace]");
  assert.ok(surface);
  assert.equal(surface.getAttribute("aria-label"), "회의실");
  assert.match(surface.textContent ?? "", /회의/);
  // The panel's exit acts the same as the map's top-right button, so it shares the same name.
  assert.equal(element.querySelector("[data-meeting-leave]")?.textContent, "오피스로");
  await act(async () => root.unmount());
});

class MeetingSocket {
  id = "socket-user";
  connected = true;
  calls: Array<{ event: string; payload: unknown }> = [];
  listeners = new Map<string, Set<(data: never) => void>>();
  on(event: string, fn: (data: never) => void) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(fn);
  }
  off(event: string, fn: (data: never) => void) {
    this.listeners.get(event)?.delete(fn);
  }
  emit(event: string, payload: unknown) {
    this.calls.push({ event, payload });
  }
  receive(event: string, payload?: unknown) {
    this.listeners.get(event)?.forEach((fn) => fn(payload as never));
  }
  connect() {
    this.connected = true;
    this.receive("connect");
  }
}

async function mountMeeting(
  socket: MeetingSocket,
  npcs = [{ id: "npc-one", name: "NPC", appearance: null }],
) {
  const element = document.createElement("div");
  document.body.appendChild(element);
  const root = createRoot(element);
  await act(async () =>
    root.render(
      <I18nProvider initialLocale="ko">
        <MeetingWorkspace
          channelId="channel"
          character={{
            id: "character",
            name: "사용자",
            appearance: { gender: "female", body: "female" } as never,
          }}
          socket={socket as never}
          npcs={npcs}
          onLeave={() => {}}
        />
      </I18nProvider>,
    ),
  );
  return {
    element,
    async close() {
      await act(async () => root.unmount());
      element.remove();
    },
  };
}

const initialState = {
  participants: [{ id: "socket-user", userId: "user-one", name: "사용자", appearance: null }],
  messages: [],
  discussion: null,
};

test("two participants without an NPC can chat on the prep screen while AI start stays disabled", async (context) => {
  const socket = new MeetingSocket();
  const view = await mountMeeting(socket, []);
  context.after(() => view.close());
  const input = view.element.querySelector<HTMLTextAreaElement>(
    "[data-meeting-chat-input] textarea",
  );
  assert.ok(input, "주제 입력과 별개인 채팅 입력이 있어야 한다");
  assert.equal(input.readOnly, true, "참가 확인 전에는 입력 불가");
  await act(async () =>
    socket.receive("meeting:state", {
      ...initialState,
      participants: [
        ...initialState.participants,
        { id: "socket-two", userId: "user-two", name: "동료", appearance: null },
      ],
    }),
  );
  assert.equal(input.readOnly, false);
  assert.ok(view.element.querySelector("[data-meeting-start]"));
  assert.equal(
    view.element.querySelector<HTMLButtonElement>("[data-meeting-start]")!.disabled,
    true,
  );
  await act(async () => fireEvent.change(input, { target: { value: "안녕하세요" } }));
  await act(async () => fireEvent.keyDown(input, { key: "Enter" }));
  assert.deepEqual(socket.calls.find((call) => call.event === "meeting:chat")?.payload, {
    channelId: "channel",
    message: "안녕하세요",
  });
  assert.equal(
    socket.calls.some(
      (call) => call.event === "meeting:start-discussion" || call.event === "meeting:user-speak",
    ),
    false,
  );
  await act(async () =>
    socket.receive("meeting:message", {
      id: "human-chat",
      senderId: "socket-two",
      senderType: "user",
      sender: "동료",
      content: "반갑습니다",
      timestamp: 1,
    }),
  );
  assert.match(view.element.textContent ?? "", /반갑습니다/);
  await act(async () => {
    socket.connected = false;
    socket.receive("disconnect");
  });
  assert.equal(input.readOnly, true, "끊긴 동안 입력 불가");
});

test("does not auto-start a discussion via reconnect/panel collapse before join succeeds", async () => {
  const socket = new MeetingSocket();
  const view = await mountMeeting(socket);
  assert.equal(socket.calls.filter((call) => call.event === "meeting:join").length, 1);
  assert.equal(
    view.element
      .querySelector("[data-meeting-join-state]")
      ?.getAttribute("data-meeting-join-state"),
    "joining",
  );
  assert.equal(view.element.querySelector("fieldset")?.disabled, true);
  await act(async () => socket.receive("meeting:state", initialState));
  assert.equal(view.element.querySelector("fieldset")?.disabled, false);
  const toggle = view.element.querySelector<HTMLButtonElement>(
    "[aria-controls=meeting-map-content]",
  )!;
  await act(async () => toggle.click());
  assert.equal(view.element.querySelector("#meeting-map-content")?.hasAttribute("hidden"), true);
  await act(async () => toggle.click());
  assert.equal(socket.calls.filter((call) => call.event === "meeting:join").length, 1);
  await act(async () => {
    socket.connected = false;
    socket.receive("disconnect");
  });
  assert.equal(view.element.querySelector("fieldset")?.disabled, true);
  await act(async () => socket.connect());
  await act(async () =>
    socket.receive("meeting:state", {
      ...initialState,
      discussion: {
        topic: "복원",
        npcs: [{ id: "npc-one", name: "NPC" }],
        mode: "manual",
        initiatorId: "user-one",
        initiatorSocketId: socket.id,
        isWaitingInput: true,
      },
      isInitiator: true,
    }),
  );
  assert.equal(
    socket.calls.some((call) => call.event === "meeting:start-discussion"),
    false,
  );
  await view.close();
  assert.equal(socket.calls.filter((call) => call.event === "meeting:leave").length, 1);
  assert.equal(
    socket.calls.some((call) => call.event === "meeting:stop"),
    false,
  );
  assert.equal(
    [...socket.listeners.values()].reduce((total, fns) => total + fns.size, 0),
    0,
  );
});

test("a real stream delivers as a single utterance and matches userId", async () => {
  const socket = new MeetingSocket();
  const view = await mountMeeting(socket);
  const speakers: unknown[] = [];
  const listen = (speaker: unknown) => speakers.push(speaker);
  EventBus.on("meeting:speaker", listen);
  await act(async () => socket.receive("meeting:state", initialState));
  await act(async () =>
    socket.receive("meeting:npc-turn-start", { npcId: "npc-one", npcName: "NPC" }),
  );
  assert.equal(speakers.filter(Boolean).length, 0);
  await act(async () =>
    socket.receive("meeting:npc-stream", { npcId: "npc-one", chunk: "Hello", done: false }),
  );
  await act(async () =>
    socket.receive("meeting:npc-stream", { npcId: "npc-one", chunk: " world", done: false }),
  );
  assert.equal(speakers.filter(Boolean).length, 1);
  await act(async () =>
    socket.receive("meeting:message", {
      id: "m1",
      senderId: socket.id,
      senderType: "user",
      sender: "사용자",
      content: "안녕",
      timestamp: 1,
    }),
  );
  assert.deepEqual(speakers.at(-1), { kind: "user", id: "user-one", utteranceId: "m1" });
  EventBus.off("meeting:speaker", listen);
  await view.close();
});

test("a user-initiated assembly shows a prep state before success and requires explicit retry on blocked", async (context) => {
  const socket = new MeetingSocket();
  const view = await mountMeeting(socket);
  context.after(() => view.close());
  await act(async () => socket.receive("meeting:state", initialState));
  const textarea = view.element.querySelector("textarea")!;
  await act(async () => fireEvent.change(textarea, { target: { value: "오늘의 계획" } }));
  const start = [...view.element.querySelectorAll("button")].find(
    (button) => button.textContent === "회의 시작",
  )!;
  assert.ok(start);
  await act(async () => start.click());
  assert.equal(socket.calls.filter((call) => call.event === "meeting:start-discussion").length, 1);
  const spatial = {
    channelId: "channel",
    spaceId: "meeting",
    generation: 1,
    phase: "assembling",
    participants: [
      { actorId: "npc-one", kind: "npc", state: "walking", seatId: null, target: { x: 1, y: 1 } },
    ],
    failure: null,
  };
  await act(async () => socket.receive("meeting:spatial-state", spatial));
  assert.ok(view.element.querySelector("[data-meeting-spatial=assembling]"));
  await act(async () =>
    socket.receive("meeting:spatial-state", {
      ...spatial,
      phase: "blocked",
      failure: { actorId: "npc-one", reasonCode: "path_unavailable" },
    }),
  );
  assert.match(view.element.textContent ?? "", /걸어갈 경로/);
  await act(async () =>
    view.element.querySelector<HTMLButtonElement>("[data-meeting-preparation-retry]")!.click(),
  );
  assert.equal(socket.calls.filter((call) => call.event === "meeting:start-discussion").length, 2);
  await act(async () =>
    view.element.querySelector<HTMLButtonElement>("[data-meeting-preparation-cancel]")!.click(),
  );
  assert.equal(
    socket.calls.filter((call) => call.event === "meeting:cancel-preparation").length,
    1,
  );
});
