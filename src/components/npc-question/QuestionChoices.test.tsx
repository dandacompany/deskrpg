import "../../test-setup/dom";

import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { I18nProvider } from "@/lib/i18n";

import QuestionChoices, { type QuestionAnswerOutcome } from "./QuestionChoices";

async function render(props: Partial<Parameters<typeof QuestionChoices>[0]>) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const sent: string[] = [];
  let outcome: QuestionAnswerOutcome = "answered";
  await act(async () => {
    root.render(
      <I18nProvider initialLocale="ko">
        <QuestionChoices
          choices={["요약", "표"]}
          allowOther
          onAnswer={async (response) => {
            sent.push(response);
            return outcome;
          }}
          {...props}
        />
      </I18nProvider>,
    );
  });
  return {
    host,
    sent,
    setOutcome: (o: QuestionAnswerOutcome) => (outcome = o),
    button: (label: string) =>
      [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === label) ?? null,
    cleanup: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

const click = (el: Element | null) =>
  act(async () => {
    assert.ok(el, "button exists");
    (el as HTMLElement).click();
  });

test("a choice button sends that choice and the component shows it was answered", async () => {
  const f = await render({});
  await click(f.button("표"));
  assert.deepEqual(f.sent, ["표"]);
  assert.match(f.host.textContent ?? "", /답함: 표/);
  assert.ok(!f.button("요약"), "choices are gone once answered");
  await f.cleanup();
});

test("the user can type their own answer when allowed", async () => {
  const f = await render({});
  await click(f.host.querySelector("[data-question-other]"));
  const input = f.host.querySelector<HTMLTextAreaElement>("[data-question-other-input]");
  assert.ok(input);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
      input,
      "둘 다",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click(f.host.querySelector("[data-question-send]"));
  assert.deepEqual(f.sent, ["둘 다"]);
  await f.cleanup();
});

test("no free-text option when only the choices are allowed", async () => {
  const f = await render({ allowOther: false });
  assert.ok(!f.host.querySelector("[data-question-other]"));
  await f.cleanup();
});

test("a question that is already gone says so and hides the choices", async () => {
  const f = await render({});
  f.setOutcome("not_found");
  await click(f.button("요약"));
  assert.match(f.host.textContent ?? "", /더 이상 답할 수 없/);
  assert.ok(!f.button("표"));
  await f.cleanup();
});

test("a closed question shows no choices", async () => {
  const f = await render({ closed: true });
  assert.ok(!f.button("요약"));
  assert.match(f.host.textContent ?? "", /끝났어요/);
  await f.cleanup();
});
