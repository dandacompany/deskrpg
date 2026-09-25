import "../../test-setup/dom";
import assert from "node:assert/strict";
import test from "node:test";

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { waitFor } from "@testing-library/react";

import { I18nProvider } from "@/lib/i18n/context";

import ArtifactEditor, { type ArtifactEditorProps } from "./ArtifactEditor";

let container: HTMLElement;
let root: Root | null = null;

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function render(props: ArtifactEditorProps) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <I18nProvider initialLocale="ko">
        <ArtifactEditor {...props} />
      </I18nProvider>,
    );
  });
  await flush();
}

test.afterEach(async () => {
  if (root) {
    const r = root;
    await act(async () => r.unmount());
    root = null;
  }
  container?.remove();
});

function byText(text: string): HTMLElement {
  const all = Array.from(container.querySelectorAll<HTMLElement>("*"));
  const hit = all.filter(
    (el) =>
      el.textContent?.trim() === text &&
      !Array.from(el.children).some((c) => c.textContent?.trim() === text),
  );
  assert.ok(hit.length > 0, `text "${text}"`);
  return hit[0];
}

function noteInput(): HTMLInputElement {
  return container.querySelector<HTMLInputElement>('input[type="text"]')!;
}

function linkInput(): HTMLInputElement {
  return container.querySelector<HTMLInputElement>('input[type="url"]')!;
}

function saveButton(): HTMLButtonElement {
  return byText("새 버전으로 저장") as HTMLButtonElement;
}

async function type(el: HTMLInputElement, value: string, opts: { replace?: boolean } = {}) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el) as object, "value")?.set;
  const next = opts.replace ? value : `${el.value}${value}`;
  setter?.call(el, next);
  await act(async () => {
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush();
}

async function click(el: HTMLElement) {
  await act(async () => el.click());
  await flush();
}

/** CodeMirror loads lazily — wait until the view attaches, then change the body via dispatch. */
async function setEditorText(text: string) {
  const view = await waitFor(() => {
    const host = container.querySelector<HTMLElement & { cmView?: unknown }>(
      '[data-testid="artifact-editor"]',
    );
    if (!host?.cmView) throw new Error("cmView not attached yet");
    return host.cmView as { state: { doc: { length: number } }; dispatch(tr: unknown): void };
  });
  await act(async () => {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  });
  await flush();
}

test("saving calls onSave with the new content and note", async () => {
  const saved: Array<[string, string]> = [];
  await render({
    initial: "# a",
    filename: "r.md",
    isLink: false,
    onSave: async (c, n) => {
      saved.push([c, n]);
    },
    onCancel: () => {},
  });
  await setEditorText("# b");
  await type(noteInput(), "제목 수정", { replace: true });
  await click(saveButton());
  assert.deepEqual(saved, [["# b", "제목 수정"]]);
});

test("a link is a single-line input, and the save button is disabled unless it's http(s)", async () => {
  await render({
    initial: "https://x.io\n",
    filename: "a.url",
    isLink: true,
    onSave: async () => {},
    onCancel: () => {},
  });
  await type(linkInput(), "javascript:alert(1)", { replace: true });
  assert.equal(saveButton().disabled, true);
});

test("with unsaved changes, cancel asks for confirmation first (in-modal confirm)", async () => {
  let cancelled = false;
  await render({
    initial: "https://x.io\n",
    filename: "a.url",
    isLink: true,
    onSave: async () => {},
    onCancel: () => {
      cancelled = true;
    },
  });
  await type(linkInput(), "https://y.io", { replace: true });
  await click(byText("취소"));
  // Shows as an in-component banner, not window.confirm.
  assert.ok(container.querySelector('[role="alertdialog"]'));
  assert.equal(cancelled, false);
  await click(byText("확인"));
  assert.equal(cancelled, true);
});

test("with no unsaved changes, cancel calls onCancel immediately", async () => {
  let cancelled = false;
  await render({
    initial: "https://x.io\n",
    filename: "a.url",
    isLink: true,
    onSave: async () => {},
    onCancel: () => {
      cancelled = true;
    },
  });
  await click(byText("취소"));
  assert.equal(cancelled, true);
  assert.ok(!container.querySelector('[role="alertdialog"]'));
});
