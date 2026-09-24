import "../../test-setup/dom";
import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { EventBus } from "@/game/EventBus";
import { useMeetingEntry } from "./use-meeting-entry";

function EntryHarness() {
  const entry = useMeetingEntry(null, "channel");
  return (
    <div data-state={entry.state.status}>
      <button onClick={entry.request}>enter</button>
      <button onClick={entry.cancel}>cancel</button>
    </div>
  );
}

test("Both walk-in and already-in-room entry connect to the same camera path after arrival and server confirmation", async (context) => {
  const element = document.createElement("div");
  document.body.appendChild(element);
  const root = createRoot(element);
  let requestCount = 0;
  const request = () => {
    requestCount++;
  };
  const camera = () => EventBus.emit("meeting:presentation-result", { ok: true });
  EventBus.on("meeting:request-entry", request);
  EventBus.on("meeting:presentation-enter", camera);
  context.after(async () => {
    await act(async () => root.unmount());
    EventBus.off("meeting:request-entry", request);
    EventBus.off("meeting:presentation-enter", camera);
    element.remove();
  });
  await act(async () => root.render(<EntryHarness />));
  const [enter, cancel] = element.querySelectorAll("button");
  await act(async () => {
    enter.click();
    enter.click();
  });
  assert.equal(requestCount, 1);
  assert.equal(element.firstElementChild?.getAttribute("data-state"), "walking");
  await act(async () => EventBus.emit("meeting:entry-state", { status: "arrived" }));
  assert.equal(element.firstElementChild?.getAttribute("data-state"), "joining");
  await act(async () => EventBus.emit("meeting:joined"));
  assert.equal(element.firstElementChild?.getAttribute("data-state"), "joined");
  await act(async () => cancel.click());
  EventBus.off("meeting:request-entry", request);
  const inside = () => EventBus.emit("meeting:entry-state", { status: "arrived" });
  EventBus.on("meeting:request-entry", inside);
  context.after(() => EventBus.off("meeting:request-entry", inside));
  await act(async () => EventBus.emit("meeting:entry-intent"));
  assert.equal(element.firstElementChild?.getAttribute("data-state"), "joining");
  await act(async () => EventBus.emit("meeting:join-failed", { reasonCode: "forbidden" }));
  assert.equal(element.firstElementChild?.getAttribute("data-state"), "failed");
  await act(async () => EventBus.emit("meeting:joined"));
  assert.equal(element.firstElementChild?.getAttribute("data-state"), "failed");
});

test("Without a WebGL renderer, it reverts the join UI instead of pretending success", async () => {
  const element = document.createElement("div");
  const root = createRoot(element);
  await act(async () => root.render(<EntryHarness />));
  await act(async () => element.querySelector("button")!.click());
  await act(async () => EventBus.emit("meeting:entry-state", { status: "arrived" }));
  await act(async () => EventBus.emit("meeting:joined"));
  assert.equal(element.firstElementChild?.getAttribute("data-state"), "failed");
  await act(async () => root.unmount());
});

test("The exit-intent from the map's '오피스로' (Back to office) button closes the in-progress meeting screen", async (context) => {
  const element = document.createElement("div");
  document.body.appendChild(element);
  const root = createRoot(element);
  const camera = () => EventBus.emit("meeting:presentation-result", { ok: true });
  EventBus.on("meeting:presentation-enter", camera);
  context.after(async () => {
    await act(async () => root.unmount());
    EventBus.off("meeting:presentation-enter", camera);
    element.remove();
  });
  await act(async () => root.render(<EntryHarness />));
  await act(async () => element.querySelector("button")!.click());
  await act(async () => EventBus.emit("meeting:entry-state", { status: "arrived" }));
  await act(async () => EventBus.emit("meeting:joined"));
  assert.equal(element.firstElementChild?.getAttribute("data-state"), "joined");
  // The top nav has no exit button — this event is the only way to leave the meeting screen outside the top nav.
  await act(async () => EventBus.emit("meeting:exit-intent"));
  assert.equal(element.firstElementChild?.getAttribute("data-state"), "idle");
});
