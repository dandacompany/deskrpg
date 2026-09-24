import "../test-setup/dom";

import assert from "node:assert/strict";
import test from "node:test";

import { act } from "react";
import { createRoot } from "react-dom/client";

import { EventBus } from "@/game/EventBus";
import { I18nProvider } from "@/lib/i18n";
import { MEETING_CAMERA_PREFS_KEY, type MeetingCameraPrefs } from "@/lib/meeting-camera-prefs";
import ViewSettingsModal from "./ViewSettingsModal";

async function mount() {
  window.localStorage.clear();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <I18nProvider>
        <ViewSettingsModal onClose={() => {}} />
      </I18nProvider>,
    );
  });
  return host;
}

function field<T extends Element>(host: HTMLElement, name: string): T {
  const el = host.querySelector(`[data-view-setting="${name}"]`);
  assert.ok(el, `${name} 입력이 없습니다`);
  return el as T;
}

test("opens at defaults — upper body, direct handoff, 2s, 1.5s", async () => {
  const host = await mount();
  assert.equal(field<HTMLSelectElement>(host, "speakerFraming").value, "upperBody");
  assert.equal(field<HTMLInputElement>(host, "directHandoff").checked, true);
  assert.equal(field<HTMLInputElement>(host, "minSpeakerDwellSeconds").value, "2");
  assert.equal(field<HTMLInputElement>(host, "holdAfterSpeechSeconds").value, "1.5");
});

test("saves to this browser immediately on change and notifies the camera — no save button", async () => {
  const host = await mount();
  const seen: MeetingCameraPrefs[] = [];
  const listener = (prefs: MeetingCameraPrefs) => seen.push(prefs);
  EventBus.on("view:meeting-camera-prefs", listener);
  try {
    const select = field<HTMLSelectElement>(host, "speakerFraming");
    await act(async () => {
      select.value = "table";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    assert.equal(seen.at(-1)?.speakerFraming, "table", "카메라에 즉시 알리지 않았습니다");
    const stored = JSON.parse(window.localStorage.getItem(MEETING_CAMERA_PREFS_KEY) ?? "{}");
    assert.equal(stored.speakerFraming, "table", "저장하지 않았습니다");
    // To avoid confusion with channel settings about "what gets saved", this screen has no save button at all.
    const labels = [...host.querySelectorAll("button")].map((b) => b.textContent ?? "");
    assert.ok(
      !labels.some((l) => /저장|Save/.test(l)),
      `저장 버튼이 있습니다: ${labels.join(",")}`,
    );
  } finally {
    EventBus.off("view:meeting-camera-prefs", listener);
  }
});

test("can turn off direct handoff and reset to defaults", async () => {
  const host = await mount();
  const box = field<HTMLInputElement>(host, "directHandoff");
  await act(async () => box.click());
  assert.equal(box.checked, false);
  await act(async () => field<HTMLButtonElement>(host, "reset").click());
  assert.equal(field<HTMLInputElement>(host, "directHandoff").checked, true);
  assert.equal(field<HTMLSelectElement>(host, "speakerFraming").value, "upperBody");
});
