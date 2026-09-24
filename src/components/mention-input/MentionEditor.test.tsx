import "../../test-setup/dom";

import assert from "node:assert/strict";
import test from "node:test";

import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";

import { I18nProvider } from "@/lib/i18n";
import MentionEditor, { type MentionEditorHandle } from "./MentionEditor";

const candidates = [
  { id: "a", name: "소피" },
  { id: "b", name: "올리버" },
  { id: "c", name: "소라" },
];

async function mount(node: React.ReactElement): Promise<{ root: Root; el: HTMLElement }> {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(node);
  });
  return { root, el };
}

function editor(el: HTMLElement): HTMLElement {
  const e = el.querySelector('[contenteditable="true"]');
  assert.ok(e, "contenteditable 편집기가 없다");
  return e as HTMLElement;
}

/** As if the user typed it: append a text node and fire an input event (the caret is assumed to be at the end). */
async function typeText(ed: HTMLElement, text: string) {
  await act(async () => {
    ed.appendChild(document.createTextNode(text));
    ed.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function keydown(ed: HTMLElement, key: string) {
  await act(async () => {
    ed.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

function items(el: HTMLElement): string[] {
  return [...el.querySelectorAll('[role="option"]')].map((o) => o.textContent?.trim() ?? "");
}

test("filters candidates by the characters after @ and shows them in the dropdown", async () => {
  const { el } = await mount(
    <I18nProvider>
      <MentionEditor candidates={candidates} value="" onChange={() => {}} onSubmit={() => {}} />
    </I18nProvider>,
  );
  await typeText(editor(el), "안녕 @소");
  assert.deepEqual(items(el), ["소피", "소라"]);
});

test("clicking a candidate turns the @query into a chip and serializes to @[name]", async () => {
  let value = "";
  const { el } = await mount(
    <I18nProvider>
      <MentionEditor
        candidates={candidates}
        value=""
        onChange={(v) => (value = v)}
        onSubmit={() => {}}
      />
    </I18nProvider>,
  );
  const ed = editor(el);
  await typeText(ed, "@소");
  await act(async () => {
    (el.querySelector('[role="option"]') as HTMLElement).click();
  });
  const chip = ed.querySelector("[data-mention-id]");
  assert.ok(chip, "칩이 없다");
  assert.equal(chip?.getAttribute("data-mention-id"), "a");
  assert.equal(chip?.getAttribute("contenteditable"), "false");
  const plain = [...ed.childNodes]
    .filter((n) => n.nodeType === Node.TEXT_NODE)
    .map((n) => n.textContent)
    .join("");
  assert.equal(plain.includes("@"), false, "@쿼리 텍스트가 남아 있다");
  assert.equal(value, "@[소피] ");
  assert.equal(items(el).length, 0, "선택 후 드롭다운이 닫혀야 한다");
});

test("Enter submits when the dropdown is closed, and selects when it's open", async () => {
  const sent: string[] = [];
  const { el } = await mount(
    <I18nProvider>
      <MentionEditor
        candidates={candidates}
        value=""
        onChange={() => {}}
        onSubmit={() => sent.push("x")}
      />
    </I18nProvider>,
  );
  const ed = editor(el);
  await typeText(ed, "@올");
  await keydown(ed, "Enter");
  assert.equal(sent.length, 0, "드롭다운이 열려 있으면 Enter 는 전송이 아니다");
  assert.equal(ed.querySelector("[data-mention-id]")?.getAttribute("data-mention-id"), "b");
  await keydown(ed, "Enter");
  assert.equal(sent.length, 1);
});

test("clear() empties the editor", async () => {
  const ref = createRef<MentionEditorHandle>();
  const { el } = await mount(
    <I18nProvider>
      <MentionEditor
        ref={ref}
        candidates={candidates}
        value=""
        onChange={() => {}}
        onSubmit={() => {}}
      />
    </I18nProvider>,
  );
  const ed = editor(el);
  await typeText(ed, "hello");
  await act(async () => ref.current?.clear());
  assert.equal(ed.textContent, "");
});

test("a selected candidate is colored with a brand token, not hardcoded white text", async () => {
  const { el } = await mount(
    <I18nProvider>
      <MentionEditor
        candidates={[{ id: "a", name: "noah" }]}
        value=""
        onChange={() => {}}
        onSubmit={() => {}}
      />
    </I18nProvider>,
  );
  await typeText(editor(el), "@no");
  const option = el.querySelector('[role="option"]');
  assert.ok(option, "후보가 하나여도 드롭다운 항목이 있어야 한다");
  assert.equal(option?.getAttribute("aria-selected"), "true", "후보가 하나면 선택 상태다");
  const cls = option?.className ?? "";
  assert.equal(/\btext-white\b/.test(cls), false, `선택 항목에 text-white 가 남아 있다: ${cls}`);
  assert.ok(/\btext-text\b/.test(cls), `선택 항목 글자색이 브랜드 토큰이 아니다: ${cls}`);
  assert.equal(/-\$\{|undefined/.test(cls), false, `조립 클래스 흔적이 있다: ${cls}`);
});

test("a mention chip is colored with a brand token, with no assembled classes", async () => {
  const { el } = await mount(
    <I18nProvider>
      <MentionEditor candidates={candidates} value="" onChange={() => {}} onSubmit={() => {}} />
    </I18nProvider>,
  );
  const ed = editor(el);
  await typeText(ed, "@소");
  await act(async () => {
    (el.querySelector('[role="option"]') as HTMLElement).click();
  });
  const cls = ed.querySelector("[data-mention-id]")?.className ?? "";
  assert.ok(/\btext-text\b/.test(cls), `칩 글자색이 브랜드 토큰이 아니다: ${cls}`);
  assert.equal(
    /-500\/|amber|indigo/.test(cls),
    false,
    `칩에 조립 팔레트 클래스가 남아 있다: ${cls}`,
  );
});
