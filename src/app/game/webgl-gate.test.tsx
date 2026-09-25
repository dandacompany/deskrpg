import "../../test-setup/dom";
import test from "node:test";
import assert from "node:assert/strict";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";

import { I18nProvider } from "../../lib/i18n/context";
import { WebglGate } from "./webgl-gate";

// `next/link` touches `self.requestIdleCallback` on mount — attach the happy-dom window as is.
Object.defineProperty(globalThis, "self", {
  value: globalThis.window,
  writable: true,
  configurable: true,
});

/**
 * Pin the gate's contract — when the check fails, the workspace **does not even mount**
 * (socket connection and data loading happen inside it, so "render but hide" is not enough).
 */
async function mount(options: { detect: () => boolean; onRetry?: () => void }) {
  const mounts: number[] = [];
  const fatalRef: { current: (() => void) | null } = { current: null };

  function Workspace({ onFatal }: { onFatal: () => void }) {
    // Count at commit, not render — "was it actually mounted" is this gate's contract.
    useEffect(() => {
      mounts.push(1);
      fatalRef.current = onFatal;
    }, [onFatal]);
    return <div data-testid="workspace">workspace</div>;
  }

  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <I18nProvider initialLocale="ko">
        <WebglGate
          detect={options.detect}
          onRetry={options.onRetry}
          renderWorkspace={(onFatal) => <Workspace onFatal={onFatal} />}
          renderChecking={() => <div data-testid="checking">checking</div>}
        />
      </I18nProvider>,
    );
  });

  return {
    host,
    mountCount: () => mounts.length,
    async fireFatal() {
      assert.ok(fatalRef.current, "워크스페이스가 마운트되지 않아 onFatal 을 받지 못했다");
      await act(async () => fatalRef.current!());
    },
    async cleanup() {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test("when the WebGL check fails, the workspace is not mounted and guidance is shown", async () => {
  const f = await mount({ detect: () => false });
  try {
    assert.equal(f.mountCount(), 0);
    assert.ok(!f.host.querySelector('[data-testid="workspace"]'));
    assert.ok(!f.host.querySelector('[data-testid="checking"]'));
    assert.match(f.host.textContent!, /3D 오피스를 시작할 수 없습니다/);
  } finally {
    await f.cleanup();
  }
});

test("when the check passes, the workspace mounts normally", async () => {
  const f = await mount({ detect: () => true });
  try {
    assert.equal(f.mountCount(), 1);
    assert.ok(f.host.querySelector('[data-testid="workspace"]'));
    assert.doesNotMatch(f.host.textContent!, /3D 오피스를 시작할 수 없습니다/);
  } finally {
    await f.cleanup();
  }
});

test("a fatal failure during the session unmounts the workspace and switches to guidance", async () => {
  const f = await mount({ detect: () => true });
  try {
    await f.fireFatal();
    assert.ok(!f.host.querySelector('[data-testid="workspace"]'));
    assert.match(f.host.textContent!, /3D 오피스를 시작할 수 없습니다/);
  } finally {
    await f.cleanup();
  }
});

test("the retry button makes the whole page recheck", async () => {
  let retried = 0;
  const f = await mount({ detect: () => false, onRetry: () => (retried += 1) });
  try {
    const button = f.host.querySelector("button");
    assert.ok(button, "다시 시도 버튼이 있어야 한다");
    await act(async () => {
      button!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
    assert.equal(retried, 1);
  } finally {
    await f.cleanup();
  }
});

test("the guidance has a link back to the channel list", async () => {
  const f = await mount({ detect: () => false });
  try {
    const link = f.host.querySelector('a[href="/channels"]');
    assert.ok(link, "채널 목록 링크가 있어야 한다");
  } finally {
    await f.cleanup();
  }
});
