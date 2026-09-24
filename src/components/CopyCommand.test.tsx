import "../test-setup/dom";
import test from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { I18nProvider } from "../lib/i18n/context";
import { CopyCommand } from "./CopyCommand";

async function mount(clipboard?: { writeText: (text: string) => Promise<void> }) {
  const original = Object.getOwnPropertyDescriptor(globalThis.navigator, "clipboard");
  Object.defineProperty(globalThis.navigator, "clipboard", {
    value: clipboard,
    configurable: true,
  });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <I18nProvider initialLocale="ko">
        <CopyCommand command="deskrpg host-setup on --with-install" />
      </I18nProvider>,
    );
  });
  return {
    host,
    async cleanup() {
      await act(async () => root.unmount());
      host.remove();
      if (original) Object.defineProperty(globalThis.navigator, "clipboard", original);
    },
  };
}

test("the command is always shown as-is on screen", async () => {
  const f = await mount(undefined);
  try {
    assert.match(f.host.textContent!, /deskrpg host-setup on --with-install/);
  } finally {
    await f.cleanup();
  }
});

test("does not add a copy button when the clipboard is unavailable", async () => {
  // The clipboard is blocked on a plain-HTTP instance — don't create a button that does nothing when pressed.
  const f = await mount(undefined);
  try {
    assert.equal(f.host.querySelector("button"), null);
  } finally {
    await f.cleanup();
  }
});

test("clicking copy sends the whole command to the clipboard and the notice changes", async () => {
  const copied: string[] = [];
  const f = await mount({
    writeText: async (text: string) => {
      copied.push(text);
    },
  });
  try {
    const button = f.host.querySelector("button")!;
    assert.equal(button.textContent, "복사");
    await act(async () => button.click());
    assert.deepEqual(copied, ["deskrpg host-setup on --with-install"]);
    assert.equal(f.host.querySelector("button")!.textContent, "복사됨");
  } finally {
    await f.cleanup();
  }
});

test("the screen does not break even if the clipboard rejects", async () => {
  const f = await mount({
    writeText: async () => {
      throw new Error("denied");
    },
  });
  try {
    await act(async () => f.host.querySelector("button")!.click());
    assert.equal(f.host.querySelector("button")!.textContent, "복사");
    assert.match(f.host.textContent!, /deskrpg host-setup/);
  } finally {
    await f.cleanup();
  }
});
