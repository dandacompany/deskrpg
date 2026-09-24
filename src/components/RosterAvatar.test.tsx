import "../test-setup/dom";
import test from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "../lib/i18n/context";
import { officeLookAppearance } from "../game/three/office-looks";
import RosterAvatar from "./RosterAvatar";

async function initialFor(locale: "ko" | "ja" | "en") {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <I18nProvider initialLocale={locale}>
        <RosterAvatar appearance={officeLookAppearance("office-jun")} />
      </I18nProvider>,
    ),
  );
  const text = host.querySelector("span")?.textContent;
  await act(async () => root.unmount());
  host.remove();
  return text;
}

test("the placeholder initial follows the viewer's language", async () => {
  assert.equal(await initialFor("ko"), "서");
  assert.equal(await initialFor("ja"), "ソ");
  assert.equal(await initialFor("en"), "J");
});
