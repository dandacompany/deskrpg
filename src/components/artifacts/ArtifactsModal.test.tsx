import "../../test-setup/dom";
import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { waitFor } from "@testing-library/react";

import { I18nProvider } from "@/lib/i18n/context";

import ArtifactsModal, { type ArtifactsModalProps } from "./ArtifactsModal";
import { composeHtml } from "./viewers/HtmlViewer";

const LIST = "GET /api/channels/ch-1/artifacts?limit=50";

const summary = (overrides: Record<string, unknown> = {}) => ({
  id: "a1",
  kind: "document",
  title: "주간 보고",
  profile: "sophie",
  source_kind: "chat",
  session_id: "s-1",
  current_version: 1,
  filename: "report.md",
  mime: "text/markdown",
  size: 12,
  sha256: "abc",
  created_at: 1_790_000_000,
  updated_at: 1_790_000_000,
  ...overrides,
});

const version = (n: number, overrides: Record<string, unknown> = {}) => ({
  version: n,
  filename: "report.md",
  mime: "text/markdown",
  size: 12,
  sha256: "abc",
  created_by: "sophie",
  captured_via: "tool",
  created_at: 1_790_000_000,
  ...overrides,
});

type Reply = Record<string, unknown>;

/** `"METHOD path"` → response. `{text}` is the raw body, `{status, json}` is an error, otherwise JSON 200. */
function mockFetch(routes: Record<string, Reply>) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const key = `${init?.method ?? "GET"} ${url}`;
    calls.push(key);
    const reply = routes[key];
    if (!reply) {
      return new Response(JSON.stringify({ code: "not_found", message: key }), { status: 404 });
    }
    if (typeof reply.text === "string") {
      return new Response(reply.text, {
        status: typeof reply.status === "number" ? reply.status : 200,
        headers: (reply.headers as Record<string, string> | undefined) ?? {},
      });
    }
    if (typeof reply.status === "number" && "json" in reply) {
      return new Response(JSON.stringify(reply.json), { status: reply.status });
    }
    return new Response(JSON.stringify(reply), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return calls;
}

const originalFetch = globalThis.fetch;
let container: HTMLElement;
let root: Root | null = null;

const baseProps: ArtifactsModalProps = {
  channelId: "ch-1",
  npcs: [{ profileName: "sophie", npcName: "소피", npcId: "n1" }],
  refreshTick: 0,
  lastEvent: null,
  onOpenSource: () => {},
  onClose: () => {},
};

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function render(props: Partial<ArtifactsModalProps> = {}) {
  if (!root) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  }
  const r = root;
  await act(async () =>
    r.render(
      <I18nProvider initialLocale="ko">
        <ArtifactsModal {...baseProps} debounceMs={0} {...props} />
      </I18nProvider>,
    ),
  );
  await flush();
}

/** The innermost element whose text is exactly `text`. */
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

function queryText(text: string): HTMLElement | undefined {
  return Array.from(container.querySelectorAll<HTMLElement>("*")).find(
    (el) => el.textContent?.trim() === text,
  );
}

async function click(el: HTMLElement) {
  await act(async () => el.click());
  await flush();
}

// Assert on booleans, never on a DOM node: a failed assertion inspects its values with
// `customInspect: false`, and walking a rendered node (its document, window and React fiber graph)
// never finishes — the file hung until the runner killed it instead of reporting the failure.
test.afterEach(async () => {
  if (root) {
    const r = root;
    await act(async () => r.unmount());
    root = null;
    container.remove();
  }
  globalThis.fetch = originalFetch;
});

test("opening loads the list, and clicking an item renders Markdown", async () => {
  mockFetch({
    [LIST]: { artifacts: [summary({ id: "a1", title: "주간 보고" })], cursor: "", has_more: false },
    "GET /api/channels/ch-1/artifacts/a1": {
      artifact: summary({ id: "a1", title: "주간 보고" }),
      versions: [version(1)],
    },
    "GET /api/channels/ch-1/artifacts/a1/versions/1/content": { text: "# 제목\n본문" },
  });
  await render();
  await click(byText("주간 보고"));
  assert.ok(container.querySelector(".markdown-chat h1"));
});

test("HTML uses sandbox=allow-scripts with no allow-same-origin", async () => {
  const web = summary({
    id: "w1",
    kind: "web",
    title: "랜딩",
    filename: "index.html",
    mime: "text/html",
  });
  mockFetch({
    [LIST]: { artifacts: [web], cursor: "", has_more: false },
    "GET /api/channels/ch-1/artifacts/w1": {
      artifact: web,
      versions: [version(1, { filename: "index.html", mime: "text/html" })],
    },
    "GET /api/channels/ch-1/artifacts/w1/versions/1/content": { text: "<h1>hi</h1>" },
  });
  await render();
  await click(byText("랜딩"));
  const iframe = container.querySelector("iframe");
  assert.ok(iframe);
  assert.equal(iframe.getAttribute("sandbox"), "allow-scripts");
  assert.ok(iframe.getAttribute("srcdoc")!.includes("<html"));
});

test("composeHtml only wraps document fragments and leaves complete documents as-is", () => {
  assert.match(composeHtml("<p>x</p>"), /^<!doctype html><html><head><meta charset="utf-8">/);
  const full = "<!DOCTYPE html><html><body>y</body></html>";
  assert.equal(composeHtml(full), full);
});

test("the link viewer doesn't turn javascript: into an open button", async () => {
  const link = summary({
    id: "l1",
    kind: "link",
    title: "수상한 링크",
    filename: "link.url",
    mime: "text/uri-list",
  });
  mockFetch({
    [LIST]: { artifacts: [link], cursor: "", has_more: false },
    "GET /api/channels/ch-1/artifacts/l1": {
      artifact: link,
      versions: [version(1, { filename: "link.url", mime: "text/uri-list" })],
    },
    "GET /api/channels/ch-1/artifacts/l1/versions/1/content": { text: "javascript:alert(1)\n" },
  });
  await render();
  await click(byText("수상한 링크"));
  assert.ok(!queryText("새 탭에서 열기"));
  assert.ok(!container.querySelector('a[href^="javascript"]'));
  assert.ok(queryText("열 수 없는 주소입니다"));
});

test("the link viewer opens http(s) as a noopener noreferrer new-tab link", async () => {
  const link = summary({
    id: "l2",
    kind: "link",
    title: "문서 링크",
    filename: "link.url",
    mime: "text/uri-list",
  });
  mockFetch({
    [LIST]: { artifacts: [link], cursor: "", has_more: false },
    "GET /api/channels/ch-1/artifacts/l2": {
      artifact: link,
      versions: [version(1, { filename: "link.url", mime: "text/uri-list" })],
    },
    "GET /api/channels/ch-1/artifacts/l2/versions/1/content": { text: "https://example.com/a\n" },
  });
  await render();
  await click(byText("문서 링크"));
  const open = byText("새 탭에서 열기").closest("a");
  assert.ok(open);
  assert.equal(open.getAttribute("href"), "https://example.com/a");
  assert.equal(open.getAttribute("target"), "_blank");
  assert.equal(open.getAttribute("rel"), "noopener noreferrer");
});

test("delete sends DELETE after confirmation and removes it from the list", async () => {
  const calls = mockFetch({
    [LIST]: { artifacts: [summary()], cursor: "", has_more: false },
    "GET /api/channels/ch-1/artifacts/a1": { artifact: summary(), versions: [version(1)] },
    "GET /api/channels/ch-1/artifacts/a1/versions/1/content": { text: "본문" },
    "DELETE /api/channels/ch-1/artifacts/a1": { ok: true },
  });
  await render();
  await click(byText("주간 보고"));
  await click(byText("삭제"));
  assert.ok(!calls.some((c) => c.startsWith("DELETE")), "확인 전에는 보내지 않는다");
  assert.ok(queryText("이 결과물의 모든 버전을 삭제할까요?"));
  await click(byText("삭제"));
  assert.ok(calls.includes("DELETE /api/channels/ch-1/artifacts/a1"));
  assert.ok(!queryText("주간 보고"));
});

test("canceling the delete confirmation doesn't send it", async () => {
  const calls = mockFetch({
    [LIST]: { artifacts: [summary()], cursor: "", has_more: false },
    "GET /api/channels/ch-1/artifacts/a1": { artifact: summary(), versions: [version(1)] },
    "GET /api/channels/ch-1/artifacts/a1/versions/1/content": { text: "본문" },
  });
  await render();
  await click(byText("주간 보고"));
  await click(byText("삭제"));
  await click(byText("취소"));
  assert.ok(!calls.some((c) => c.startsWith("DELETE")));
  assert.ok(byText("삭제"));
});

test("bumping refreshTick reloads the list", async () => {
  const calls = mockFetch({ [LIST]: { artifacts: [], cursor: "", has_more: false } });
  await render();
  assert.equal(calls.filter((c) => c === LIST).length, 1);
  await render({ refreshTick: 1 });
  assert.equal(calls.filter((c) => c === LIST).length, 2);
});

test("opening with taskId attaches taskId to the list request", async () => {
  const calls = mockFetch({
    "GET /api/channels/ch-1/artifacts?taskId=t-9&limit=50": {
      artifacts: [],
      cursor: "",
      has_more: false,
    },
  });
  await render({ initialTaskId: "t-9" });
  // Card-attachment lookups (board list/attachments) go out too, so only check the artifact-list request.
  assert.deepEqual(
    calls.filter((c) => c.includes("/artifacts")),
    ["GET /api/channels/ch-1/artifacts?taskId=t-9&limit=50"],
  );
});

test("an artifact.deleted event removes that item and clears the selection", async () => {
  mockFetch({
    [LIST]: { artifacts: [summary()], cursor: "", has_more: false },
    "GET /api/channels/ch-1/artifacts/a1": { artifact: summary(), versions: [version(1)] },
    "GET /api/channels/ch-1/artifacts/a1/versions/1/content": { text: "# 제목" },
  });
  await render({ initialArtifactId: "a1" });
  assert.ok(container.querySelector(".markdown-chat h1"));
  await render({ lastEvent: { kind: "artifact.deleted", artifactId: "a1" } });
  assert.ok(!queryText("주간 보고"));
  assert.ok(!container.querySelector(".markdown-chat"));
});

test("428 renders the plugin-update notice", async () => {
  mockFetch({
    [LIST]: {
      status: 428,
      json: { code: "plugin_upgrade_required", message: "upgrade", minVersion: "0.8.0" },
    },
  });
  await render();
  assert.ok(queryText("플러그인을 0.8.0 이상으로 업데이트하세요"));
});

test("409 renders the gateway-connection notice", async () => {
  mockFetch({
    [LIST]: { status: 409, json: { code: "gateway_not_bound", message: "no gateway" } },
  });
  await render();
  assert.ok(container.querySelector('[data-gate="gateway"]'));
});

test("a version pruned by the retention limit can't be selected", async () => {
  const a = summary({ current_version: 2 });
  mockFetch({
    [LIST]: { artifacts: [a], cursor: "", has_more: false },
    "GET /api/channels/ch-1/artifacts/a1": {
      artifact: a,
      versions: [version(2), version(1, { pruned_at: 1_790_000_100 })],
    },
    "GET /api/channels/ch-1/artifacts/a1/versions/2/content": { text: "v2" },
  });
  await render();
  await click(byText("주간 보고"));
  const options = Array.from(container.querySelectorAll("option")).filter((o) =>
    o.textContent?.startsWith("v"),
  );
  const pruned = options.find((o) => o.value === "1");
  assert.ok(pruned);
  assert.equal(pruned.disabled, true);
  assert.match(pruned.textContent ?? "", /보존 한도로 정리됨/);
});

test("go-to-source passes sourceTarget", async () => {
  const card = summary({ source_kind: "kanban", task_id: "t-7" });
  mockFetch({
    [LIST]: { artifacts: [card], cursor: "", has_more: false },
    "GET /api/channels/ch-1/artifacts/a1": { artifact: card, versions: [version(1)] },
    "GET /api/channels/ch-1/artifacts/a1/versions/1/content": { text: "x" },
  });
  const seen: unknown[] = [];
  await render({ onOpenSource: (target) => seen.push(target) });
  await click(byText("주간 보고"));
  await click(byText("출처로 이동"));
  assert.deepEqual(seen, [{ type: "kanban", taskId: "t-7" }]);
});

test("a board artifact shows the card it was made in and the cards it built on, each opening that card", async () => {
  const card = summary({ source_kind: "kanban", task_id: "t-7", board: "b" });
  mockFetch({
    [LIST]: { artifacts: [card], cursor: "", has_more: false },
    "GET /api/channels/ch-1/artifacts/a1": {
      artifact: card,
      versions: [version(1)],
      provenance: {
        task: { id: "t-7", title: "뉴스레터 초안", status: "done", assignee: "sophie" },
        run: { profile: "sophie", outcome: "completed", started_at: 100, ended_at: 200 },
        parents: [{ id: "t-3", title: "자료 조사", status: "done" }],
        moreParents: 2,
      },
    },
    "GET /api/channels/ch-1/artifacts/a1/versions/1/content": { text: "x" },
  });
  const seen: unknown[] = [];
  await render({ onOpenSource: (target) => seen.push(target) });
  await click(byText("주간 보고"));
  const block = container.querySelector("[data-artifact-provenance]");
  assert.equal(block !== null, true);
  assert.equal((block?.textContent ?? "").includes("sophie"), true);
  assert.equal((block?.textContent ?? "").includes("외 2장"), true);
  await click(byText("자료 조사"));
  await click(byText("뉴스레터 초안"));
  assert.deepEqual(seen, [
    { type: "kanban", taskId: "t-3" },
    { type: "kanban", taskId: "t-7" },
  ]);
});

test("an artifact without provenance shows no provenance block", async () => {
  mockFetch({
    [LIST]: { artifacts: [summary()], cursor: "", has_more: false },
    "GET /api/channels/ch-1/artifacts/a1": { artifact: summary(), versions: [version(1)] },
    "GET /api/channels/ch-1/artifacts/a1/versions/1/content": { text: "x" },
  });
  await render();
  await click(byText("주간 보고"));
  assert.equal(container.querySelector("[data-artifact-provenance]") === null, true);
});

test("edit -> save calls addVersion and moves on to the new version", async () => {
  const a = summary({ current_version: 1 });
  const calls = mockFetch({
    [LIST]: { artifacts: [a], cursor: "", has_more: false },
    "GET /api/channels/ch-1/artifacts/a1": { artifact: a, versions: [version(1)] },
    "GET /api/channels/ch-1/artifacts/a1/versions/1/content": { text: "# 제목\n본문" },
    "POST /api/channels/ch-1/artifacts/a1/versions": {
      version: version(2, { captured_via: "edit", note: "고침" }),
    },
  });
  await render();
  await click(byText("주간 보고"));
  await click(byText("편집"));
  assert.ok(container.querySelector('[data-testid="artifact-editor"]'), "에디터가 떠야 한다");

  // Register the post-save refetch response at this point — it selects the new version and refetches its body.
  const updated = summary({ current_version: 2 });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const key = `${init?.method ?? "GET"} ${url}`;
    calls.push(key);
    if (key === "GET /api/channels/ch-1/artifacts/a1") {
      return new Response(
        JSON.stringify({ artifact: updated, versions: [version(2), version(1)] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (key === "GET /api/channels/ch-1/artifacts/a1/versions/2/content") {
      return new Response(JSON.stringify({ text: "# 제목 수정\n본문" }), { status: 200 });
    }
    if (key === "POST /api/channels/ch-1/artifacts/a1/versions") {
      return new Response(
        JSON.stringify({ version: version(2, { captured_via: "edit", note: "고침" }) }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ code: "not_found", message: key }), { status: 404 });
  }) as typeof fetch;

  const cmHost = container.querySelector<HTMLElement & { cmView?: unknown }>(
    '[data-testid="artifact-editor"]',
  );
  const view = await waitFor(() => {
    if (!cmHost?.cmView) throw new Error("cmView not attached yet");
    return cmHost.cmView as { state: { doc: { length: number } }; dispatch(tr: unknown): void };
  });
  await act(async () => {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "# 제목 수정\n본문" } });
  });
  await flush();

  await click(byText("새 버전으로 저장"));
  assert.ok(calls.includes("POST /api/channels/ch-1/artifacts/a1/versions"));
  assert.ok(
    container.querySelector('[data-testid="artifact-editor"]') === null,
    "저장 뒤 편집 모드를 닫는다",
  );
  assert.ok(queryText("새 버전으로 저장했습니다"));
});

/** List -> open a1 -> edit -> changes the CodeMirror body to `text`. Returns the changed view. */
async function openAndEdit(text: string) {
  await click(byText("주간 보고"));
  await click(byText("편집"));
  const cmHost = container.querySelector<HTMLElement & { cmView?: unknown }>(
    '[data-testid="artifact-editor"]',
  );
  const view = await waitFor(() => {
    if (!cmHost?.cmView) throw new Error("cmView not attached yet");
    return cmHost.cmView as {
      state: { doc: { length: number; toString(): string } };
      dispatch(tr: unknown): void;
    };
  });
  await act(async () => {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  });
  await flush();
  return view;
}

function editableRoutes() {
  const a = summary({ current_version: 1 });
  return {
    [LIST]: { artifacts: [a], cursor: "", has_more: false },
    "GET /api/channels/ch-1/artifacts/a1": {
      artifact: a,
      versions: [version(1)],
      modifiable: true,
    },
    "GET /api/channels/ch-1/artifacts/a1/versions/1/content": { text: "# 제목\n본문" },
  };
}

test("F1: a preview truncated at 512 KB has no edit button", async () => {
  const a = summary({ size: 2_000_000 });
  mockFetch({
    [LIST]: { artifacts: [a], cursor: "", has_more: false },
    "GET /api/channels/ch-1/artifacts/a1": {
      artifact: a,
      versions: [version(1)],
      modifiable: true,
    },
    "GET /api/channels/ch-1/artifacts/a1/versions/1/content": {
      text: "# 앞부분",
      status: 206,
      headers: { "content-range": "bytes 0-524287/2000000" },
    },
  });
  await render();
  await click(byText("주간 보고"));
  assert.ok(queryText("512 KB 까지만 표시했습니다 — 다운로드해서 보세요"), "잘림 안내");
  assert.equal(queryText("편집") === undefined, true, "잘린 본문은 편집할 수 없다");
  assert.ok(queryText("잘린 미리보기라 편집할 수 없습니다"));
});

test("F3: when modifiable is false, edit/delete are hidden and a read-only notice shows", async () => {
  const card = summary({ source_kind: "kanban", task_id: "t-9", board: "deskrpg-other" });
  mockFetch({
    [LIST]: { artifacts: [card], cursor: "", has_more: false },
    "GET /api/channels/ch-1/artifacts/a1": {
      artifact: card,
      versions: [version(1)],
      modifiable: false,
      sourceInChannel: false,
    },
    "GET /api/channels/ch-1/artifacts/a1/versions/1/content": { text: "# 제목" },
  });
  const seen: unknown[] = [];
  await render({ onOpenSource: (target) => seen.push(target) });
  await click(byText("주간 보고"));
  assert.ok(container.querySelector(".markdown-chat h1"), "읽기는 된다");
  assert.equal(queryText("편집") === undefined, true);
  assert.equal(queryText("삭제") === undefined, true);
  assert.ok(queryText("다른 오피스에서 만든 결과물 — 읽기 전용"));
  const go = byText("출처로 이동").closest("button")!;
  assert.equal(go.disabled, true, "다른 채널 보드의 카드로는 이동하지 않는다");
  await click(go);
  assert.deepEqual(seen, []);
});

test("F2: a new-version event for the same artifact while editing keeps the editor and body and only shows a notice", async () => {
  const calls = mockFetch(editableRoutes());
  await render();
  const view = await openAndEdit("# 내가 고친 본문");
  const detailCalls = () => calls.filter((c) => c === "GET /api/channels/ch-1/artifacts/a1").length;
  const before = detailCalls();
  await render({ refreshTick: 1, lastEvent: { kind: "artifact.versioned", artifactId: "a1" } });
  assert.ok(container.querySelector('[data-testid="artifact-editor"]'), "편집기가 그대로다");
  assert.equal(view.state.doc.toString(), "# 내가 고친 본문");
  assert.ok(queryText("새 버전이 저장됐습니다 — 저장하면 그 위에 새 버전이 됩니다"));
  assert.equal(detailCalls(), before, "편집 중에는 다시 읽지 않는다");

  // Discarding the edit and closing is when it refetches.
  await click(byText("취소"));
  await click(byText("확인"));
  assert.equal(container.querySelector('[data-testid="artifact-editor"]') === null, true);
  assert.ok(detailCalls() > before, "편집이 끝나면 새 버전을 읽는다");
});

test("F2: with unsaved changes, Escape/backdrop/close button don't close the modal and instead show a confirmation", async () => {
  mockFetch(editableRoutes());
  let closed = 0;
  await render({ onClose: () => (closed += 1) });
  await openAndEdit("# 고친 본문");

  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  });
  await flush();
  assert.equal(closed, 0, "Escape 가 편집을 버리고 닫으면 안 된다");
  assert.ok(queryText("저장되지 않은 변경 사항이 있습니다. 계속할까요?"));
  await click(byText("뒤로"));

  const backdrop = container.querySelector<HTMLElement>(".fixed.inset-0")!;
  await click(backdrop);
  assert.equal(closed, 0, "배경 클릭도 확인을 거친다");
  assert.ok(queryText("저장되지 않은 변경 사항이 있습니다. 계속할까요?"));
  await click(byText("뒤로"));

  // The viewer's X (close) — also goes through confirmation while editing.
  const closeButtons = Array.from(
    container.querySelectorAll<HTMLButtonElement>('button[aria-label="닫기"]'),
  );
  await click(closeButtons[closeButtons.length - 1]);
  assert.ok(container.querySelector('[data-testid="artifact-editor"]'), "뷰어를 닫지 않는다");
  assert.ok(queryText("저장되지 않은 변경 사항이 있습니다. 계속할까요?"));

  // Only closes once confirmed.
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  });
  await flush();
  await click(byText("확인"));
  assert.equal(closed, 1);
});

test("there are exactly four tabs: all/media/file/link", async () => {
  mockFetch({ [LIST]: { artifacts: [], cursor: "", has_more: false } });
  await render();
  const tabs = Array.from(container.querySelectorAll<HTMLElement>('[role="tab"]')).map((el) =>
    el.textContent?.trim(),
  );
  assert.deepEqual(tabs, ["전체", "미디어", "파일", "링크"]);
});

test("clicking the media tab attaches category=media to the list request", async () => {
  const calls = mockFetch({
    [LIST]: { artifacts: [], cursor: "", has_more: false },
    "GET /api/channels/ch-1/artifacts?category=media&limit=50": {
      artifacts: [],
      cursor: "",
      has_more: false,
    },
  });
  await render();
  await click(byText("미디어"));
  assert.ok(calls.includes("GET /api/channels/ch-1/artifacts?category=media&limit=50"));
});

test("on a gate failure, a button that opens the checklist shows, and clicking it opens the checklist", async () => {
  mockFetch({
    [LIST]: { status: 404, json: { code: "plugin_absent", message: "not installed" } },
  });
  await render();
  assert.ok(queryText("무엇이 필요한가요?"));
  await click(byText("무엇이 필요한가요?"));
  assert.ok(queryText("DeskRPG 플러그인 설치"));
});

test("once the gate clears, the open checklist closes and a later failure does not reopen it", async () => {
  mockFetch({
    [LIST]: { status: 404, json: { code: "plugin_absent", message: "not installed" } },
  });
  await render();
  await click(byText("무엇이 필요한가요?"));
  assert.ok(queryText("DeskRPG 플러그인 설치"));

  mockFetch({ [LIST]: { artifacts: [], cursor: "", has_more: false } });
  await render({ refreshTick: 1 });
  assert.ok(!queryText("DeskRPG 플러그인 설치"), "the checklist closed itself");

  mockFetch({
    [LIST]: { status: 404, json: { code: "plugin_absent", message: "not installed" } },
  });
  await render({ refreshTick: 2 });
  assert.ok(queryText("무엇이 필요한가요?"));
  assert.ok(!queryText("DeskRPG 플러그인 설치"), "a new failure waits for a click");
});

test("a plain error (no code) doesn't show the checklist button", async () => {
  mockFetch({
    [LIST]: { status: 500, json: { code: "internal_error", message: "boom" } },
  });
  await render();
  assert.ok(!queryText("무엇이 필요한가요?"));
});

test("the media tab grid renders images as thumbnails and audio/video as icon tiles", async () => {
  const img = summary({
    id: "img1",
    kind: "image",
    title: "그림",
    filename: "a.png",
    mime: "image/png",
  });
  const audio = summary({
    id: "aud1",
    kind: "media",
    title: "오디오",
    filename: "a.mp3",
    mime: "audio/mpeg",
  });
  mockFetch({
    [LIST]: { artifacts: [], cursor: "", has_more: false },
    "GET /api/channels/ch-1/artifacts?category=media&limit=50": {
      artifacts: [img, audio],
      cursor: "",
      has_more: false,
    },
  });
  await render();
  await click(byText("미디어"));
  assert.ok(container.querySelector('img[alt="그림"]'), "이미지는 썸네일이다");
  assert.ok(!container.querySelector('img[alt="오디오"]'), "오디오는 썸네일이 아니다");
  assert.ok(queryText("오디오"), "오디오는 제목이 붙은 타일이다");
});

// ---------------------------------------------------------------------------
// Card attachments — files the worker created are deleted along with scratch once the card
// finishes, leaving only the attachment.
// ---------------------------------------------------------------------------

const PROJECTS = "GET /api/channels/ch-1/projects";
const ATTACHMENTS_B1 = "GET /api/channels/ch-1/kanban/attachments?board=b1";
const oneBoard = {
  projects: [
    {
      id: "p1",
      boardSlug: "b1",
      name: null,
      status: "active",
      isEventCarrier: true,
      targetDate: null,
    },
  ],
};

test("card attachments are appended after artifacts with an 'attachment' badge and the card title", async () => {
  mockFetch({
    [LIST]: { artifacts: [summary({ id: "a1", title: "주간 보고" })], cursor: "", has_more: false },
    [PROJECTS]: oneBoard,
    [ATTACHMENTS_B1]: {
      supported: true,
      attachments: [
        { id: "att1", filename: "sales.csv", size: 3, task_id: "t9", task_title: "매출 정리" },
      ],
      next_cursor: null,
    },
  });
  await render();
  const section = container.querySelector('[data-testid="card-attachments"]');
  assert.ok(section, "끝난 카드의 첨부가 갤러리에 없다");
  assert.match(section.textContent ?? "", /sales\.csv/);
  assert.match(section.textContent ?? "", /매출 정리/);
  assert.match(section.textContent ?? "", /첨부/);
  const link = section.querySelector("a");
  assert.equal(link?.getAttribute("href"), "/api/channels/ch-1/kanban/attachments/att1?board=b1");
});

test("if the same card's same file also exists as an artifact, it doesn't reappear on the attachment side", async () => {
  mockFetch({
    [LIST]: {
      artifacts: [summary({ id: "a1", title: "보고서", filename: "report.md", task_id: "t1" })],
      cursor: "",
      has_more: false,
    },
    [PROJECTS]: oneBoard,
    [ATTACHMENTS_B1]: {
      supported: true,
      attachments: [
        { id: "att1", filename: "report.md", size: 3, task_id: "t1", task_title: "주간" },
      ],
      next_cursor: null,
    },
  });
  await render();
  assert.ok(
    !container.querySelector('[data-testid="card-attachments"]'),
    "같은 문서가 두 번 나온다",
  );
});

test("when the plugin doesn't know the attachment list, it renders only artifacts and notes why in one line", async () => {
  mockFetch({
    [LIST]: { artifacts: [summary({ id: "a1", title: "주간 보고" })], cursor: "", has_more: false },
    [PROJECTS]: oneBoard,
    [ATTACHMENTS_B1]: { supported: false, attachments: [], next_cursor: null },
  });
  await render();
  assert.ok(byText("주간 보고"), "아티팩트까지 사라졌다");
  assert.ok(
    container.querySelector('[data-testid="card-attachments-unsupported"]'),
    "첨부가 조용히 빠졌다 — 사용자는 왜 없는지 모른다",
  );
});

test("even if the attachment lookup fails, the gallery doesn't break and shows no notice", async () => {
  mockFetch({
    [LIST]: { artifacts: [summary({ id: "a1", title: "주간 보고" })], cursor: "", has_more: false },
    [PROJECTS]: oneBoard,
    [ATTACHMENTS_B1]: { status: 503, json: { code: "board_unavailable", message: "x" } },
  });
  await render();
  assert.ok(byText("주간 보고"));
  assert.ok(!container.querySelector('[data-testid="card-attachments-unsupported"]'));
});
