import "../../test-setup/dom";
import test from "node:test";
import assert from "node:assert/strict";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import { I18nProvider } from "../../lib/i18n/context";
import { BugReportModal } from "./BugReportModal";
import { FALLBACK_SURVEY } from "./feedback-client";
import { SurveyModal } from "./SurveyModal";

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

function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

const button = (host: HTMLElement, text: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(text)) as
    HTMLButtonElement | undefined;

function stubFetch(respond: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; body: unknown }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return respond(url, init);
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

test("when the collection server is off there is no private-send button, and the GitHub button only enables once title and body are filled in", async () => {
  const m = await mount(<BugReportModal feedbackUrl={null} onClose={() => {}} />);
  assert.equal(button(m.host, "비공개로 보내기"), undefined);
  const gh = button(m.host, "GitHub 이슈로 올리기")!;
  assert.equal(gh.disabled, true);
  const [title] = m.host.querySelectorAll("input");
  const [body] = m.host.querySelectorAll("textarea");
  await act(async () => {
    type(title, "맵 멈춤");
    type(body, "회의 뒤 멈춤");
  });
  assert.equal(gh.disabled, false);
  await m.cleanup();
});

test("unchecking an attachment excludes it from the GitHub issue body", async () => {
  const opened: string[] = [];
  const originalOpen = window.open;
  window.open = ((url: string) => {
    opened.push(url);
    return null;
  }) as typeof window.open;
  const m = await mount(<BugReportModal feedbackUrl={null} onClose={() => {}} />);
  const [title] = m.host.querySelectorAll("input");
  const [body] = m.host.querySelectorAll("textarea");
  await act(async () => {
    type(title, "t");
    type(body, "b");
  });
  const browserBox = m.host.querySelector('input[aria-label="브라우저"]') as HTMLInputElement;
  await act(async () => browserBox.click());
  await act(async () => button(m.host, "GitHub 이슈로 올리기")!.click());
  window.open = originalOpen;
  const issueBody = new URL(opened[0]).searchParams.get("body") ?? "";
  assert.ok(issueBody.includes("version"));
  assert.ok(!issueBody.includes("userAgent"));
  await m.cleanup();
});

test("private sending posts to the collection server and shows the completion message", async () => {
  const f = stubFetch(() => new Response("{}", { status: 201 }));
  const m = await mount(<BugReportModal feedbackUrl="https://fb.test" onClose={() => {}} />);
  const [title] = m.host.querySelectorAll("input");
  const [body] = m.host.querySelectorAll("textarea");
  await act(async () => {
    type(title, "t");
    type(body, "b");
  });
  await act(async () => button(m.host, "비공개로 보내기")!.click());
  f.restore();
  assert.equal(f.calls[0].url, "https://fb.test/v1/bug-reports");
  assert.equal((f.calls[0].body as { title: string }).title, "t");
  assert.ok(m.host.textContent?.includes("감사합니다"));
  await m.cleanup();
});

test("sending the survey posts the answers and set version and ends in sent, and shows an alert on failure", async () => {
  let outcome = "";
  const f = stubFetch(() => new Response("{}", { status: 201 }));
  const m = await mount(
    <SurveyModal
      survey={FALLBACK_SURVEY}
      locale="ko"
      feedbackUrl="https://fb.test"
      consentNeeded
      onDone={(o) => (outcome = o)}
    />,
  );
  assert.ok(m.host.textContent?.includes("익명 전송"));
  await act(async () =>
    (m.host.querySelector('[role="radio"]:nth-child(10)') as HTMLButtonElement).click(),
  );
  await act(async () => button(m.host, "보내기")!.click());
  f.restore();
  assert.equal(outcome, "sent");
  assert.deepEqual((f.calls[0].body as { answers: unknown; setVersion: number }).answers, {
    nps: 9,
  });
  assert.equal((f.calls[0].body as { setVersion: number }).setVersion, 1);
  await m.cleanup();

  const failing = stubFetch(() => new Response("{}", { status: 500 }));
  let failedOutcome = "";
  const m2 = await mount(
    <SurveyModal
      survey={FALLBACK_SURVEY}
      locale="ko"
      feedbackUrl="https://fb.test"
      consentNeeded={false}
      onDone={(o) => (failedOutcome = o)}
    />,
  );
  assert.ok(!m2.host.textContent?.includes("익명 전송"));
  await act(async () => button(m2.host, "보내기")!.click());
  failing.restore();
  assert.equal(failedOutcome, "");
  assert.ok(m2.host.querySelector('[role="alert"]'));
  await act(async () => button(m2.host, "다시 묻지 않기")!.click());
  assert.equal(failedOutcome, "never");
  await m2.cleanup();
});

test("the guidance text in the survey/bug modals does not use the dim text color — 3.8:1 on the cream background fails AA", async () => {
  const survey = await mount(
    <SurveyModal
      survey={FALLBACK_SURVEY}
      locale="ko"
      feedbackUrl="https://fb.test"
      consentNeeded
      onDone={() => {}}
    />,
  );
  const bug = await mount(<BugReportModal feedbackUrl="https://fb.test" onClose={() => {}} />);
  for (const host of [survey.host, bug.host]) {
    const dim = [...host.querySelectorAll("p, label, button")].filter(
      (el) => el.className.includes("text-text-dim") && el.getAttribute("aria-label") === null,
    );
    assert.deepEqual(
      dim.map((el) => el.textContent),
      [],
    );
  }
  await survey.cleanup();
  await bug.cleanup();
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

test("the bug report modal closes on Esc and consumes that Esc; it ignores an Esc already consumed by a layer above", async () => {
  let closed = 0;
  const m = await mount(<BugReportModal feedbackUrl={null} onClose={() => closed++} />);
  pressEscape(true);
  assert.equal(closed, 0);
  const event = pressEscape();
  assert.equal(closed, 1);
  assert.equal(event.defaultPrevented, true);
  await m.cleanup();
});

test("Esc in the survey modal is the same as 'later' — it is not recorded as never-ask-again", async () => {
  const outcomes: string[] = [];
  const m = await mount(
    <SurveyModal
      survey={FALLBACK_SURVEY}
      locale="ko"
      feedbackUrl="https://fb.test"
      consentNeeded={false}
      onDone={(o) => outcomes.push(o)}
    />,
  );
  pressEscape(true);
  assert.deepEqual(outcomes, []);
  const event = pressEscape();
  assert.deepEqual(outcomes, ["later"]);
  assert.equal(event.defaultPrevented, true);
  await m.cleanup();
});
