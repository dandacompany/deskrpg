import "../../test-setup/dom";

import assert from "node:assert/strict";
import test from "node:test";

import { act } from "react";
import { createRoot } from "react-dom/client";

import { I18nProvider } from "@/lib/i18n";
import GroupAccessPanel from "./GroupAccessPanel";

const responses: Record<string, unknown> = {
  members: {
    members: [
      {
        userId: "u2",
        role: "group_admin",
        approvedBy: null,
        approvedAt: null,
        joinedAt: null,
        loginId: "dev3",
        nickname: "dev3",
      },
    ],
  },
  invites: { invites: [] },
  "join-requests": { joinRequests: [] },
  permissions: { permissions: [] },
  "user-overrides": {
    overrides: [
      {
        id: "o1",
        userId: "u1",
        permissionKey: "manage_group_members",
        effect: "deny",
        createdBy: null,
        createdAt: "2026-09-19T00:00:00.000Z",
        loginId: "alice",
        nickname: "앨리스",
      },
    ],
  },
};

test("permission rows show human-readable names and translated values instead of raw keys", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const section = url.split("/").pop() ?? "";
    return new Response(JSON.stringify(responses[section] ?? {}), { status: 200 });
  }) as typeof fetch;

  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  try {
    await act(async () => {
      root.render(
        <I18nProvider initialLocale="ko">
          <GroupAccessPanel
            groupId="g1"
            groupName="Default"
            canManageMembers
            canManagePermissions
            canApproveJoinRequests
          />
        </I18nProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const text = el.textContent ?? "";
    assert.match(text, /오피스 만들기/);
    assert.match(text, /멤버 관리/);
    assert.match(text, /상속/);
    assert.match(text, /거부/);
    assert.match(text, /그룹 관리자/);
    for (const raw of [
      "create_channel",
      "manage_group_members",
      "inherit",
      "deny",
      "group_admin",
      "member",
    ]) {
      assert.ok(!text.includes(raw), `원시 값 "${raw}" 가 화면에 보인다`);
    }
  } finally {
    await act(async () => root.unmount());
    el.remove();
    globalThis.fetch = originalFetch;
  }
});

async function renderPanel(canResetPasswords: boolean, fetchImpl: typeof fetch) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  globalThis.fetch = fetchImpl;
  await act(async () => {
    root.render(
      <I18nProvider initialLocale="ko">
        <GroupAccessPanel
          groupId="g1"
          groupName="Default"
          canManageMembers
          canManagePermissions
          canApproveJoinRequests
          canResetPasswords={canResetPasswords}
        />
      </I18nProvider>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { el, root };
}

const sectionFetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  const section = url.split("/").pop() ?? "";
  return new Response(JSON.stringify(responses[section] ?? {}), { status: 200 });
}) as typeof fetch;

test("without system admin rights, there is no reset password button", async () => {
  const originalFetch = globalThis.fetch;
  const { el, root } = await renderPanel(false, sectionFetch);
  try {
    assert.ok(!(el.textContent ?? "").includes("비밀번호 재설정"));
  } finally {
    await act(async () => root.unmount());
    el.remove();
    globalThis.fetch = originalFetch;
  }
});

test("when a system admin resets it, the temporary password is shown once on screen", async () => {
  const originalFetch = globalThis.fetch;
  const originalConfirm = globalThis.confirm;
  globalThis.confirm = () => true;
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("reset-password")) {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      return new Response(
        JSON.stringify({
          temporaryPassword: "temp-secret-value",
          user: { id: "u2", loginId: "dev3", nickname: "dev3" },
        }),
        { status: 200 },
      );
    }
    const section = url.split("/").pop() ?? "";
    return new Response(JSON.stringify(responses[section] ?? {}), { status: 200 });
  }) as typeof fetch;

  const { el, root } = await renderPanel(true, fetchImpl);
  try {
    const button = Array.from(el.querySelectorAll("button")).find((node) =>
      (node.textContent ?? "").includes("비밀번호 재설정"),
    );
    assert.ok(button, "재설정 버튼이 보이지 않는다");

    await act(async () => {
      button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    assert.deepEqual(calls, ["POST /api/admin/users/u2/reset-password"]);
    assert.match(el.textContent ?? "", /temp-secret-value/);
  } finally {
    await act(async () => root.unmount());
    el.remove();
    globalThis.fetch = originalFetch;
    globalThis.confirm = originalConfirm;
  }
});
