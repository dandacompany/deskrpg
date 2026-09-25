import "../../test-setup/dom";
import test from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { I18nProvider } from "../../lib/i18n/context";
import DiagnosticsPanel from "./DiagnosticsPanel";

const report = {
  environment: { errors: ["JWT_SECRET 이 비어 있습니다"], warnings: [], dbTarget: "sqlite" },
  database: { ok: false, target: "sqlite", message: "SQLite 파일에 접근할 수 없습니다" },
  hostSetup: { wizard: true, hermesInstall: false },
  gateways: [
    {
      id: "g1",
      label: "우리 게이트웨이",
      pluginStatus: "ready",
      checkedAt: "2026-09-15T00:00:00.000Z",
    },
  ],
};

async function fixture(handler: typeof fetch) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <I18nProvider initialLocale="ko">
        <DiagnosticsPanel />
      </I18nProvider>,
    ),
  );
  return {
    host,
    cleanup: async () => {
      await act(async () => root.unmount());
      host.remove();
      globalThis.fetch = original;
    },
  };
}

test("renders nothing at all when it gets a 404", async () => {
  const { host, cleanup } = await fixture(
    async () => new Response(JSON.stringify({ errorCode: "not_found" }), { status: 404 }),
  );
  try {
    assert.ok(!host.querySelector("[data-testid='diagnostics-panel']"));
    assert.equal(host.textContent, "");
  } finally {
    await cleanup();
  }
});

test("an admin sees environment/DB/host switches/gateways as a collapsible section", async () => {
  const { host, cleanup } = await fixture(async () => new Response(JSON.stringify(report)));
  try {
    const panel = host.querySelector("[data-testid='diagnostics-panel']");
    assert.ok(panel, "진단 영역이 있어야 한다");
    assert.equal(panel.tagName, "DETAILS");
    const text = panel.textContent ?? "";
    assert.ok(text.includes("진단"));
    assert.ok(text.includes("JWT_SECRET 이 비어 있습니다"));
    assert.ok(text.includes("SQLite 파일에 접근할 수 없습니다"));
    assert.ok(text.includes("✓ DESKRPG_HOST_SETUP_ENABLED"));
    assert.ok(text.includes("✗ DESKRPG_HERMES_INSTALL_ENABLED"));
    assert.ok(text.includes("우리 게이트웨이"));
  } finally {
    await cleanup();
  }
});

test("shows only the failure message when the fetch fails", async () => {
  const { host, cleanup } = await fixture(async () => {
    throw new Error("network down");
  });
  try {
    const panel = host.querySelector("[data-testid='diagnostics-panel']");
    assert.ok(panel);
    assert.ok((panel.textContent ?? "").includes("진단을 불러오지 못했습니다"));
  } finally {
    await cleanup();
  }
});
