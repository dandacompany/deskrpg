import "../../test-setup/dom";

import assert from "node:assert/strict";
import test from "node:test";

import { act } from "react";
import { createRoot } from "react-dom/client";

import { useGateBlocker } from "./useGateBlocker";

function Probe({ onReady }: { onReady: (api: ReturnType<typeof useGateBlocker>) => void }) {
  const api = useGateBlocker();
  onReady(api);
  return <span>{api.blocker?.kind ?? "none"}</span>;
}

test("passing a failure classifies and stores it, and clearing empties it", async () => {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  let api!: ReturnType<typeof useGateBlocker>;

  await act(async () => {
    root.render(<Probe onReady={(next) => (api = next)} />);
  });
  assert.equal(el.textContent, "none");

  await act(async () => api.show({ status: 404, code: "plugin_absent" }));
  assert.equal(el.textContent, "plugin_absent");

  await act(async () => api.clear());
  assert.equal(el.textContent, "none");

  await act(async () => root.unmount());
  el.remove();
});

test("also accepts an error object with status/code", async () => {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  let api!: ReturnType<typeof useGateBlocker>;

  await act(async () => {
    root.render(<Probe onReady={(next) => (api = next)} />);
  });

  await act(async () => api.showFromError({ status: 409, code: "gateway_not_bound" }));
  assert.equal(el.textContent, "gateway_not_bound");

  // An error with a different shape falls through to other, without throwing.
  await act(async () => api.showFromError(new Error("그냥 오류")));
  assert.equal(el.textContent, "other");

  await act(async () => root.unmount());
  el.remove();
});
