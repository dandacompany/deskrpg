import "../../test-setup/dom";
import test from "node:test";
import assert from "node:assert/strict";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import { I18nProvider } from "../../lib/i18n/context";
import { GrowthStarButton } from "./GrowthStarButton";
import { UpdateNoticeModal } from "./UpdateNoticeModal";

async function mount(node: ReactNode) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<I18nProvider initialLocale="ko">{node}</I18nProvider>));
  return {
    host,
    async cleanup() {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test("the Star button shows an abbreviated count, and links to the repo without a number when the count is unknown", async () => {
  const withCount = await mount(
    <GrowthStarButton stars={1234} clicked={false} onClick={() => {}} />,
  );
  assert.equal(
    withCount.host.querySelector("[data-testid=growth-star-count]")?.textContent,
    "1.2k",
  );
  assert.equal(
    withCount.host.querySelector("a")?.getAttribute("href"),
    "https://github.com/dandacompany/deskrpg",
  );
  await withCount.cleanup();

  const noCount = await mount(<GrowthStarButton stars={null} clicked={false} onClick={() => {}} />);
  assert.equal(noCount.host.querySelector("[data-testid=growth-star-count]"), null);
  await noCount.cleanup();
});

test("clicking the Star button calls onClick, and no longer uses the highlight color afterward", async () => {
  let clicks = 0;
  const m = await mount(<GrowthStarButton stars={3} clicked={false} onClick={() => clicks++} />);
  const a = m.host.querySelector("a")!;
  a.addEventListener("click", (e) => e.preventDefault());
  await act(async () => a.click());
  assert.equal(clicks, 1);
  await m.cleanup();

  const quiet = await mount(<GrowthStarButton stars={3} clicked onClick={() => {}} />);
  assert.doesNotMatch(quiet.host.querySelector("a")!.className, /bg-primary/);
  await quiet.cleanup();
});

test("the update notice marks itself seen the moment it opens and links to that release's notes", async () => {
  let seen = 0;
  const m = await mount(
    <UpdateNoticeModal
      version="2026.921.3"
      latestVersion="2026.922.0"
      onSeen={() => seen++}
      onClose={() => {}}
    />,
  );
  assert.equal(seen, 1);
  assert.ok(m.host.textContent?.includes("v2026.922.0"));
  const link = [...m.host.querySelectorAll("a")].find((a) => a.href.includes("/releases/tag/"));
  assert.equal(
    link?.getAttribute("href"),
    "https://github.com/dandacompany/deskrpg/releases/tag/2026.922.0",
  );
  await m.cleanup();
});

/** A single cancelable Esc bubbling up from body, like in a real browser. Does not rely on jsdom's listener order. */
function pressEscape(consumedAbove = false) {
  const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  if (consumedAbove) event.preventDefault();
  act(() => {
    document.body.dispatchEvent(event);
  });
  return event;
}

test("the update notice closes on Esc and consumes that Esc; it ignores an Esc already consumed by a layer above", async () => {
  let closed = 0;
  const m = await mount(
    <UpdateNoticeModal
      version="2026.921.3"
      latestVersion="2026.922.0"
      onSeen={() => {}}
      onClose={() => closed++}
    />,
  );
  pressEscape(true);
  assert.equal(closed, 0);
  const event = pressEscape();
  assert.equal(closed, 1);
  assert.equal(event.defaultPrevented, true);
  await m.cleanup();
});
