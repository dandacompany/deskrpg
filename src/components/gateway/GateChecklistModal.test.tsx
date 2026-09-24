import "../../test-setup/dom";

import assert from "node:assert/strict";
import test from "node:test";

import { act } from "react";
import { createRoot } from "react-dom/client";

import { I18nProvider } from "@/lib/i18n";
import type { GateBlocker } from "@/lib/gate-failure";
import GateChecklistModal from "./GateChecklistModal";

async function render(blocker: GateBlocker | null) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(
      <I18nProvider initialLocale="ko">
        <GateChecklistModal blocker={blocker} onClose={() => {}} />
      </I18nProvider>,
    );
  });
  return { el, root };
}

async function cleanup(root: ReturnType<typeof createRoot>, el: HTMLElement) {
  await act(async () => root.unmount());
  el.remove();
}

test("renders nothing when there is no blocker", async () => {
  const { el, root } = await render(null);
  assert.equal(el.textContent, "");
  await cleanup(root, el);
});

test("only the blocked step gets a remedy — plugin not installed", async () => {
  const { el, root } = await render({ kind: "plugin_absent", command: "install me" });
  const text = el.textContent ?? "";
  // All four steps are visible.
  for (const step of [
    "게이트웨이 연결",
    "리스너 소유자 키",
    "DeskRPG 플러그인 설치",
    "플러그인 버전",
  ]) {
    assert.ok(text.includes(step), `${step} 가 없다`);
  }
  // Only the blocked step's guidance and command are visible.
  assert.ok(text.includes("Hermes API 서버를 다시 시작"));
  assert.ok(text.includes("install me"));
  // Other steps' guidance is not visible.
  assert.ok(!text.includes("리스너 소유자 키(API_SERVER_KEY)여야"));
  await cleanup(root, el);
});

test("upgrade includes the minimum version in its message", async () => {
  const { el, root } = await render({
    kind: "plugin_upgrade_required",
    minVersion: "0.9.0",
    command: "install me",
  });
  assert.match(el.textContent ?? "", /0\.9\.0/);
  await cleanup(root, el);
});

test("gateway not bound gives a link to the connection screen", async () => {
  const { el, root } = await render({ kind: "gateway_not_bound" });
  const link = Array.from(el.querySelectorAll("a")).find((a) =>
    (a.textContent ?? "").includes("연결 화면 열기"),
  );
  assert.ok(link, "연결 화면 링크가 없다");
  assert.equal(link!.getAttribute("href"), "/gateways");
  await cleanup(root, el);
});

test("connection/server issues do not render the checklist", async () => {
  for (const blocker of [{ kind: "unreachable" } as const, { kind: "timeout" } as const]) {
    const { el, root } = await render(blocker);
    const text = el.textContent ?? "";
    assert.ok(!text.includes("DeskRPG 플러그인 설치"), `${blocker.kind} 에 단계가 보인다`);
    assert.ok(text.length > 0, `${blocker.kind} 에 아무 설명이 없다`);
    await cleanup(root, el);
  }
});

test("other failures show the code and message as-is", async () => {
  const { el, root } = await render({
    kind: "other",
    status: 500,
    code: "boom",
    message: "터졌다",
  });
  const text = el.textContent ?? "";
  assert.ok(text.includes("boom"));
  assert.ok(text.includes("터졌다"));
  await cleanup(root, el);
});
