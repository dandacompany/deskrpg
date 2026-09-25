import "../../test-setup/dom";

import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { I18nProvider } from "@/lib/i18n";
import type { AttentionRow } from "@/lib/attention-inbox";

import AttentionInboxPanel from "./AttentionInboxPanel";
import type { AttentionInbox } from "./attention-api";

const EMPTY_COUNTS = { awaiting_approval: 0, blocked: 0, review: 0, total: 0 };

function fakeApi(pages: AttentionInbox[]) {
  const decided: { approvalId: string; body: unknown }[] = [];
  let index = 0;
  return {
    decided,
    loads: () => index,
    client: {
      async load() {
        return pages[Math.min(index++, pages.length - 1)];
      },
      async decide(approvalId: string, body: unknown) {
        decided.push({ approvalId, body });
        return {};
      },
    } as never,
  };
}

async function render(node: React.ReactElement) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<I18nProvider initialLocale="ko">{node}</I18nProvider>);
  });
  return {
    host,
    cleanup: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

const approvalRow: AttentionRow = {
  kind: "approval",
  id: "a1",
  title: "2건 수행할까요?",
  at: "2026-09-21T00:00:01.000Z",
  requestedBy: "sophie",
  count: 2,
};

test("shows the empty state when there is nothing to answer", async () => {
  const api = fakeApi([{ rows: [], counts: EMPTY_COUNTS }]);
  const { host, cleanup } = await render(<AttentionInboxPanel channelId="c1" api={api.client} />);
  assert.ok(host.querySelector("[data-attention-empty]"));
  await cleanup();
});

test("an approval row has three decision buttons and renders the requester as a profile", async () => {
  const api = fakeApi([
    { rows: [approvalRow], counts: { ...EMPTY_COUNTS, awaiting_approval: 2, total: 2 } },
  ]);
  const { host, cleanup } = await render(<AttentionInboxPanel channelId="c1" api={api.client} />);
  const row = host.querySelector('[data-attention-row="approval"]');
  assert.ok(row, "승인 줄이 없다");
  assert.equal(row!.querySelectorAll("[data-decision]").length, 3);
  assert.ok((row!.textContent ?? "").includes("sophie"), "요청한 직원을 보여야 한다");
  await cleanup();
});

test("a bundle a human registered is not rendered under a staff name", async () => {
  // Rendering `user:<id>` as a profile would claim something that wasn't said.
  const api = fakeApi([
    {
      rows: [{ ...approvalRow, requestedBy: "user:7e0a0f1c-1111-4222-8333-444455556666" }],
      counts: EMPTY_COUNTS,
    },
  ]);
  const { host, cleanup } = await render(<AttentionInboxPanel channelId="c1" api={api.client} />);
  const text = host.textContent ?? "";
  assert.ok(!text.includes("user:"), "저장 형식이 그대로 노출되면 안 된다");
  assert.ok(text.includes("사람이 등록"));
  await cleanup();
});

test("clicking approve sends that decision to the route and reloads the list", async () => {
  const api = fakeApi([
    { rows: [approvalRow], counts: EMPTY_COUNTS },
    { rows: [], counts: EMPTY_COUNTS },
  ]);
  const { host, cleanup } = await render(<AttentionInboxPanel channelId="c1" api={api.client} />);
  const button = host.querySelector('[data-decision="approve"]') as HTMLButtonElement;
  await act(async () => button.click());
  assert.deepEqual(api.decided, [{ approvalId: "a1", body: { decision: "approve" } }]);
  // No optimistic update — the server is the source of truth, so we reload.
  assert.equal(api.loads(), 2);
  assert.ok(host.querySelector("[data-attention-empty]"), "결정한 줄이 사라져야 한다");
  await cleanup();
});

test("a note, when entered, is sent along with the decision", async () => {
  const api = fakeApi([{ rows: [approvalRow], counts: EMPTY_COUNTS }]);
  const { host, cleanup } = await render(<AttentionInboxPanel channelId="c1" api={api.client} />);
  const input = host.querySelector("input") as HTMLInputElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(input, "범위가 넓습니다");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const button = host.querySelector('[data-decision="reject"]') as HTMLButtonElement;
  await act(async () => button.click());
  assert.deepEqual(api.decided[0].body, { decision: "reject", note: "범위가 넓습니다" });
  await cleanup();
});

test("a non-approval row has no decision buttons, only an open action", async () => {
  const api = fakeApi([
    {
      rows: [
        { kind: "blocked", id: "t1", title: "오류로 막힘", at: null, requestedBy: null, count: 1 },
        {
          kind: "cron_failed",
          id: "j1",
          title: "야간 집계",
          at: "2026-09-21T00:00:02.000Z",
          requestedBy: null,
          count: 1,
        },
      ],
      counts: EMPTY_COUNTS,
    },
  ]);
  const opened: string[] = [];
  const cronOpened: string[] = [];
  const { host, cleanup } = await render(
    <AttentionInboxPanel
      channelId="c1"
      api={api.client}
      onOpenCard={(id) => opened.push(id)}
      onOpenCronJob={(id) => cronOpened.push(id)}
    />,
  );
  assert.equal(host.querySelectorAll("[data-decision]").length, 0);
  await act(async () =>
    (host.querySelector('[data-attention-row="blocked"] button') as HTMLButtonElement).click(),
  );
  await act(async () =>
    (host.querySelector('[data-attention-row="cron_failed"] button') as HTMLButtonElement).click(),
  );
  assert.deepEqual(opened, ["t1"]);
  assert.deepEqual(cronOpened, ["j1"], "크론 실패는 카드가 아니라 이력으로 간다");
  await cleanup();
});

test("on failure, shows the reason and lets the user retry", async () => {
  let calls = 0;
  const client = {
    async load() {
      calls += 1;
      if (calls === 1) throw new Error("plugin_upgrade_required");
      return { rows: [], counts: EMPTY_COUNTS };
    },
    async decide() {
      return {};
    },
  } as never;
  const { host, cleanup } = await render(<AttentionInboxPanel channelId="c1" api={client} />);
  assert.ok(host.querySelector("[data-attention-error]"));
  assert.ok((host.textContent ?? "").includes("plugin_upgrade_required"), "이유를 접지 않는다");
  await act(async () =>
    (host.querySelector("[data-attention-error] button") as HTMLButtonElement).click(),
  );
  assert.ok(host.querySelector("[data-attention-empty]"));
  await cleanup();
});

const blockedRow = (over: Record<string, unknown> = {}) =>
  ({
    kind: "approval_blocked",
    id: "m1",
    messageId: "m1",
    title: "nightly backup",
    at: "2026-09-25T00:00:00.000Z",
    requestedBy: null,
    count: 1,
    npcId: "n-1",
    subtitle: "rm -rf /tmp/build",
    patternKey: "recursive delete",
    canAllowlist: true,
    source: "cron",
    jobName: "nightly backup",
    blockKind: "command",
    ...over,
  }) as unknown as AttentionRow;

function fakePolicy(fail = false) {
  const added: { npcId: string; entry: string; noticeMessageId?: string }[] = [];
  return {
    added,
    factory: (npcId: string) =>
      ({
        async addAllowlist(entry: string, noticeMessageId?: string) {
          if (fail) throw new Error("boom");
          added.push({ npcId, entry, noticeMessageId });
          return {};
        },
      }) as never,
  };
}

test("a blocked unattended run shows the job and the blocked command", async () => {
  const api = fakeApi([{ rows: [blockedRow()], counts: EMPTY_COUNTS }]);
  const { host, cleanup } = await render(<AttentionInboxPanel channelId="c1" api={api.client} />);
  const row = host.querySelector('[data-attention-row="approval_blocked"]');
  assert.ok(row);
  assert.ok((row!.textContent ?? "").includes("무인 실행이 막힘"));
  assert.ok((row!.textContent ?? "").includes("nightly backup"));
  assert.equal(row!.querySelector("code")?.textContent, "rm -rf /tmp/build");
  await cleanup();
});

test("the owner adds the blocking rule key to the allowlist, then sees it added", async () => {
  const api = fakeApi([{ rows: [blockedRow()], counts: EMPTY_COUNTS }]);
  const policy = fakePolicy();
  const { host, cleanup } = await render(
    <AttentionInboxPanel channelId="c1" api={api.client} policyApi={policy.factory} />,
  );
  const button = host.querySelector('[data-action="allowlist-add"]') as HTMLButtonElement;
  assert.ok((button.textContent ?? "").includes("규칙 'recursive delete'"));
  await act(async () => button.click());
  assert.deepEqual(policy.added, [
    { npcId: "n-1", entry: "recursive delete", noticeMessageId: "m1" },
  ]);
  assert.ok(host.querySelector("[data-allowlist-added]"));
  assert.ok(!host.querySelector('[data-action="allowlist-add"]'));
  await cleanup();
});

test("a failed allowlist add keeps the button and shows an error", async () => {
  const api = fakeApi([{ rows: [blockedRow()], counts: EMPTY_COUNTS }]);
  const policy = fakePolicy(true);
  const { host, cleanup } = await render(
    <AttentionInboxPanel channelId="c1" api={api.client} policyApi={policy.factory} />,
  );
  await act(async () =>
    (host.querySelector('[data-action="allowlist-add"]') as HTMLButtonElement).click(),
  );
  assert.ok(host.querySelector("[data-error]"));
  assert.ok(host.querySelector('[data-action="allowlist-add"]'));
  await cleanup();
});

test("an owner's block without a rule key offers the run policy instead", async () => {
  const api = fakeApi([
    {
      rows: [
        blockedRow({
          patternKey: null,
          blockKind: "mcp",
          subtitle: "github.delete_repo",
          tool: "github.delete_repo",
          source: "kanban",
          taskTitle: "Clean up repos",
          jobName: undefined,
        }),
      ],
      counts: EMPTY_COUNTS,
    },
  ]);
  const opened: string[] = [];
  const { host, cleanup } = await render(
    <AttentionInboxPanel
      channelId="c1"
      api={api.client}
      onOpenApprovalPolicy={(npcId) => opened.push(npcId)}
    />,
  );
  const text = host.textContent ?? "";
  assert.ok(text.includes("도구 github.delete_repo"));
  assert.ok(text.includes("Clean up repos"));
  assert.ok(text.includes("모드를 바꾸는 것만 가능합니다"));
  assert.ok(!host.querySelector('[data-action="allowlist-add"]'));
  await act(async () =>
    (host.querySelector('[data-action="open-policy"]') as HTMLButtonElement).click(),
  );
  assert.deepEqual(opened, ["n-1"]);
  await cleanup();
});

test("a non-owner is told to ask the gateway owner", async () => {
  const api = fakeApi([{ rows: [blockedRow({ canAllowlist: false })], counts: EMPTY_COUNTS }]);
  const { host, cleanup } = await render(<AttentionInboxPanel channelId="c1" api={api.client} />);
  assert.ok(
    (host.querySelector("[data-ask-owner]")?.textContent ?? "").includes("게이트웨이 소유자"),
  );
  assert.ok(!host.querySelector('[data-action="allowlist-add"]'));
  assert.ok(!host.querySelector('[data-action="open-policy"]'));
  await cleanup();
});
