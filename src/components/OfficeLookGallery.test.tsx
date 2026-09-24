import "../test-setup/dom";
import test from "node:test";
import assert from "node:assert/strict";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "../lib/i18n/context";
import { OFFICE_LOOKS } from "../game/three/office-looks";
import OfficeLookGallery from "./OfficeLookGallery";

test("StrictMode cancels obsolete thumbnail jobs and WebGL failure leaves selectable cards", async () => {
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  let contextAttempts = 0;
  const originalRequest = globalThis.requestAnimationFrame;
  const originalCancel = globalThis.cancelAnimationFrame;
  const canvasPrototype = Object.getPrototypeOf(
    document.createElement("canvas"),
  ) as HTMLCanvasElement;
  const originalContext = canvasPrototype.getContext;
  const originalError = console.error;
  globalThis.requestAnimationFrame = (callback) => {
    const id = ++nextFrame;
    frames.set(id, callback);
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => {
    frames.delete(id);
  };
  canvasPrototype.getContext = (() => {
    contextAttempts++;
    return null;
  }) as typeof originalContext;
  console.error = (...args) => {
    if (!String(args[0]).includes("THREE.WebGLRenderer")) originalError(...args);
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let selected: string | undefined;
  try {
    await act(async () =>
      root.render(
        <StrictMode>
          <I18nProvider initialLocale="en">
            <OfficeLookGallery
              onSelect={(look) => {
                selected = look.id;
              }}
            />
          </I18nProvider>
        </StrictMode>,
      ),
    );
    assert.equal(contextAttempts, 0, "GPU allocation waits until the scheduled frame");
    assert.equal(frames.size, 1, "StrictMode cleanup removes the first generation");
    assert.equal(host.querySelectorAll(".lookbook-card").length, OFFICE_LOOKS.length);
    const [id, callback] = [...frames.entries()][0];
    frames.delete(id);
    await act(async () => callback(0));
    assert.ok(contextAttempts > 0);
    assert.equal(frames.size, 0, "Failed WebGL allocation does not schedule further frames");
    await act(async () => (host.querySelector(".lookbook-card") as HTMLButtonElement).click());
    assert.equal(selected, OFFICE_LOOKS[0].id);
    await act(async () => root.unmount());
    assert.equal(frames.size, 0);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    globalThis.requestAnimationFrame = originalRequest;
    globalThis.cancelAnimationFrame = originalCancel;
    canvasPrototype.getContext = originalContext;
    console.error = originalError;
  }
});

async function renderGallery(locale: "ja" | "ko") {
  const originalRequest = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = () => 0; // no thumbnail capture — text cards only
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <I18nProvider initialLocale={locale}>
        <OfficeLookGallery onSelect={() => {}} />
      </I18nProvider>,
    ),
  );
  return {
    host,
    async cleanup() {
      await act(async () => root.unmount());
      host.remove();
      globalThis.requestAnimationFrame = originalRequest;
    },
  };
}

test("the Japanese gallery shows no Hangul", async () => {
  const { host, cleanup } = await renderGallery("ja");
  try {
    assert.equal(host.querySelectorAll(".lookbook-card").length, OFFICE_LOOKS.length);
    assert.doesNotMatch(host.textContent ?? "", /[가-힣]/);
    const input = host.querySelector("input[type=search]") as HTMLInputElement;
    assert.doesNotMatch(`${input.placeholder} ${input.getAttribute("aria-label")}`, /[가-힣]/);
  } finally {
    await cleanup();
  }
});

test("searching a Korean name finds the look on the Japanese screen", async () => {
  const { host, cleanup } = await renderGallery("ja");
  try {
    const input = host.querySelector("input[type=search]") as HTMLInputElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(input, "서준");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const cards = host.querySelectorAll(".lookbook-card");
    assert.equal(cards.length, 1);
    assert.match(cards[0].textContent ?? "", /ソジュン/);
  } finally {
    await cleanup();
  }
});
