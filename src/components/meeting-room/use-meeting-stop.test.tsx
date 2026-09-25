import "../../test-setup/dom";
import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { useMeetingStop, type MeetingStopSocket } from "./use-meeting-stop";

class FakeSocket implements MeetingStopSocket {
  handlers = new Map<string, Set<(payload?: unknown) => void>>();
  emitted: [string, unknown][] = [];
  on(event: string, handler: (payload?: unknown) => void) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
    return this;
  }
  off(event: string, handler: (payload?: unknown) => void) {
    this.handlers.get(event)?.delete(handler);
    return this;
  }
  emit(event: string, payload: unknown) {
    this.emitted.push([event, payload]);
    return this;
  }
  async fire(event: string) {
    await act(async () => {
      for (const h of this.handlers.get(event) ?? []) h({});
    });
  }
}

type Api = ReturnType<typeof useMeetingStop>;

async function mount(context: test.TestContext, timeoutMs = 20_000) {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const socket = new FakeSocket();
  const root = createRoot(document.createElement("div"));
  const api: { current: Api | null } = { current: null };
  const sink = (value: Api) => {
    api.current = value;
  };
  function Harness() {
    sink(useMeetingStop(socket, "c1", timeoutMs));
    return null;
  }
  await act(async () => root.render(<Harness />));
  context.after(async () => {
    await act(async () => root.unmount());
  });
  return { socket, api };
}

test("the first stop emits once and marks the meeting as stopping; repeat clicks are ignored", async (t) => {
  const { socket, api } = await mount(t);
  assert.equal(api.current!.stopping, false);
  await act(async () => api.current!.stop());
  await act(async () => api.current!.stop());
  await act(async () => api.current!.stop());
  assert.deepEqual(socket.emitted, [["meeting:stop", { channelId: "c1" }]]);
  assert.equal(api.current!.stopping, true);
});

for (const event of ["meeting:end", "meeting:error", "disconnect"]) {
  test(`${event} clears the stopping state so stop can be sent again`, async (t) => {
    const { socket, api } = await mount(t);
    await act(async () => api.current!.stop());
    await socket.fire(event);
    assert.equal(api.current!.stopping, false);
    await act(async () => api.current!.stop());
    assert.equal(socket.emitted.length, 2);
  });
}

test("a stop the server never answers unlocks after the timeout", async (t) => {
  const { api } = await mount(t, 1_000);
  await act(async () => api.current!.stop());
  await act(async () => t.mock.timers.tick(999));
  assert.equal(api.current!.stopping, true);
  await act(async () => t.mock.timers.tick(1));
  assert.equal(api.current!.stopping, false);
});
