import "../../test-setup/dom";

import assert from "node:assert/strict";
import test from "node:test";

import { act } from "react";
import { createRoot } from "react-dom/client";

import { I18nProvider } from "@/lib/i18n";
import { CronApiError } from "./cron-api";
import CronEditorDialog from "./CronEditorDialog";

/**
 * When the delivery target list can't be fetched: the local fallback must stay alive (doesn't
 * block the form), and if it was a gate failure the user must be able to see the cause.
 */
test("shows a notice when the delivery-target preload is blocked by the gate", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("delivery-targets")) {
      return new Response(
        JSON.stringify({ code: "plugin_absent", error: "plugin is not installed" }),
        { status: 404 },
      );
    }
    return new Response(JSON.stringify({}), { status: 200 });
  }) as typeof fetch;

  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  try {
    await act(async () => {
      root.render(
        <I18nProvider initialLocale="ko">
          <CronEditorDialog
            channelId="c1"
            npcs={[{ npcId: "n1", npcName: "테스트 NPC" }]}
            timezone={null}
            onSubmit={async () => {}}
            onClose={() => {}}
          />
        </I18nProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // The local fallback must still be selectable — a gate failure doesn't block the form.
    const localCheckbox = el.querySelector('[data-testid="cron-deliver-local"]');
    assert.ok(localCheckbox, "local 배달처 체크박스가 남아 있어야 한다");

    const text = el.textContent ?? "";
    assert.match(text, /무엇이 필요한가요\?/);
  } finally {
    await act(async () => root.unmount());
    el.remove();
    globalThis.fetch = originalFetch;
  }
});

/**
 * A plain 500/network error is not a gate failure — showing a "setup needed" button would be
 * a false signal (it's not in the net that `isSetupBlocker` filters for).
 */
test("the checklist button doesn't show for a plain error", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("delivery-targets")) {
      return new Response(JSON.stringify({ code: "internal_error", error: "boom" }), {
        status: 500,
      });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  }) as typeof fetch;

  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  try {
    await act(async () => {
      root.render(
        <I18nProvider initialLocale="ko">
          <CronEditorDialog
            channelId="c1"
            npcs={[{ npcId: "n1", npcName: "테스트 NPC" }]}
            timezone={null}
            onSubmit={async () => {}}
            onClose={() => {}}
          />
        </I18nProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // The local fallback is still selectable.
    const localCheckbox = el.querySelector('[data-testid="cron-deliver-local"]');
    assert.ok(localCheckbox, "local 배달처 체크박스가 남아 있어야 한다");

    const text = el.textContent ?? "";
    assert.doesNotMatch(text, /무엇이 필요한가요\?/);
  } finally {
    await act(async () => root.unmount());
    el.remove();
    globalThis.fetch = originalFetch;
  }
});

test("CronApiError carries status/code through as-is", () => {
  const err = new CronApiError(404, "plugin_absent", "nope", {});
  assert.equal(err.status, 404);
  assert.equal(err.code, "plugin_absent");
});
