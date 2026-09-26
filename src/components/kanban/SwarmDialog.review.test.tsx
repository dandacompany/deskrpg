import "../../test-setup/dom";

import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "@/lib/i18n";
import SwarmDialog, { type SwarmSubmit } from "./SwarmDialog";

const WORKER_TITLE = "맡길 일";
const SUBMIT = "스웜 시작";

const npcs = [
  { npcId: "a", npcName: "에이", profileName: "a", active: true },
  { npcId: "b", npcName: "비", profileName: "b", active: true },
  { npcId: "c", npcName: "씨", profileName: "c", active: true },
];

async function render(policyModes: ("human" | "agent" | "mixed")[]) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const submitted: SwarmSubmit[] = [];
  await act(async () =>
    root.render(
      <I18nProvider initialLocale="ko">
        <SwarmDialog
          npcs={npcs}
          submitting={false}
          policyModes={policyModes}
          onSubmit={(values) => submitted.push(values)}
          onClose={() => {}}
        />
      </I18nProvider>,
    ),
  );
  const setValue = async (
    el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
    v: string,
  ) =>
    act(async () => {
      const proto = Object.getPrototypeOf(el);
      Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, v);
      el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
    });
  return {
    host,
    submitted,
    setValue,
    cleanup: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test("without swarm policies there is no approval picker", async () => {
  const view = await render([]);
  try {
    assert.equal(Boolean(view.host.querySelector("#swarm-review-mode")), false);
  } finally {
    await view.cleanup();
  }
});

test("a mixed swarm sends its AI reviewer, chosen outside the workers", async () => {
  const view = await render(["human", "agent", "mixed"]);
  try {
    const mode = view.host.querySelector<HTMLSelectElement>("#swarm-review-mode");
    assert.ok(mode);
    assert.deepEqual(
      [...mode.options].map((o) => o.value),
      ["human", "agent", "mixed"],
    );
    await view.setValue(mode, "mixed");
    const reviewer = view.host.querySelector<HTMLSelectElement>("#swarm-reviewer");
    assert.ok(reviewer);
    // Worker "a" is the only worker row, so it can't review.
    assert.equal(
      [...reviewer.options].some((o) => o.value === "a"),
      false,
    );
    await view.setValue(reviewer, "c");
    await view.setValue(view.host.querySelector<HTMLInputElement>("#swarm-goal")!, "목표");
    await view.setValue(
      view.host.querySelector<HTMLInputElement>(`input[aria-label="${WORKER_TITLE}"]`)!,
      "조사",
    );
    await act(async () =>
      [...view.host.querySelectorAll("button")].find((b) => b.textContent === SUBMIT)!.click(),
    );
    assert.deepEqual(view.submitted.at(-1)?.reviewPolicy, { mode: "mixed", reviewerNpcId: "c" });
  } finally {
    await view.cleanup();
  }
});
