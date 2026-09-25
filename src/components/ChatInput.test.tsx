import "../test-setup/dom";

import assert from "node:assert/strict";
import test from "node:test";

import { act } from "react";
import { createRoot } from "react-dom/client";

import { I18nProvider } from "@/lib/i18n";
import ChatInput from "./ChatInput";

async function mount(node: React.ReactElement): Promise<HTMLElement> {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(node);
  });
  return el;
}

test("with no candidates, it's still a textarea as before", async () => {
  const el = await mount(
    <I18nProvider>
      <ChatInput onSend={() => {}} />
    </I18nProvider>,
  );
  assert.ok(el.querySelector("textarea"));
  assert.equal(el.querySelector('[contenteditable="true"]'), null);
});

test("with candidates present, it uses the mention editor and serializes the send value as @[name]", async () => {
  const sent: string[] = [];
  const el = await mount(
    <I18nProvider>
      <ChatInput onSend={(m) => sent.push(m)} mentionCandidates={[{ id: "a", name: "소피" }]} />
    </I18nProvider>,
  );
  const ed = el.querySelector('[contenteditable="true"]') as HTMLElement;
  assert.ok(ed);
  assert.equal(el.querySelector("textarea"), null);
  await act(async () => {
    ed.appendChild(document.createTextNode("@소"));
    ed.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    (el.querySelector('[role="option"]') as HTMLElement).click();
  });
  await act(async () => {
    ed.appendChild(document.createTextNode("안녕"));
    ed.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    ed.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
  });
  assert.deepEqual(sent, ["@[소피] 안녕"]);
  assert.equal(ed.textContent, "", "전송 후 편집기가 비워져야 한다");
});

test("controlled draft reports edits and clears through its owner after sending", async () => {
  const changes: string[] = [];
  const sent: string[] = [];
  const el = await mount(
    <I18nProvider>
      <ChatInput
        onSend={(message) => sent.push(message)}
        value="저장된 초안"
        onValueChange={(value) => changes.push(value)}
      />
    </I18nProvider>,
  );
  const textarea = el.querySelector("textarea") as HTMLTextAreaElement;
  assert.equal(textarea.value, "저장된 초안");

  await act(async () => {
    const Textarea = textarea.ownerDocument.defaultView!.HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(Textarea.prototype, "value")?.set;
    setter?.call(textarea, "수정된 초안");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  assert.deepEqual(changes, ["수정된 초안"]);

  await act(async () => {
    textarea.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
  });
  assert.deepEqual(sent, ["저장된 초안"]);
  assert.deepEqual(changes, ["수정된 초안", ""]);
});

test("while a reply is running, the send button becomes a stop button", async () => {
  let stops = 0;
  const el = await mount(
    <I18nProvider initialLocale="ko">
      <ChatInput onSend={() => {}} onStop={() => (stops += 1)} />
    </I18nProvider>,
  );
  const stop = el.querySelector('[data-testid="chat-stop"]') as HTMLButtonElement;
  assert.ok(stop, "a stop button replaces send");
  assert.equal(stop.disabled, false, "stopping needs no draft");
  assert.equal(
    [...el.querySelectorAll("button")].some((b) => b.textContent?.trim() === "전송"),
    false,
  );
  await act(async () => stop.click());
  assert.equal(stops, 1);
});
