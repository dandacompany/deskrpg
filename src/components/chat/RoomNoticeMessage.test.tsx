import "../../test-setup/dom";

import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { I18nProvider, type Locale } from "@/lib/i18n";
import type { RoomMessage } from "@/lib/chat-rooms-policy";
import RoomNoticeMessage from "./RoomNoticeMessage";

// R29/R30: notice sentences are built in the viewer's locale. All four locales include the
// card title/job name, an unknown kind falls back to content, and this component isn't
// used when there's no notice.

function message(overrides: Partial<RoomMessage>): RoomMessage {
  return {
    id: "m1",
    roomId: "office",
    senderKind: "npc",
    senderId: "npc-a",
    senderName: "소피",
    content: "fallback content",
    createdAt: "2026-09-14T00:00:00Z",
    notice: null,
    ...overrides,
  };
}

async function render(
  node: React.ReactElement,
  locale: Locale,
): Promise<{ host: HTMLElement; cleanup: () => Promise<void> }> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<I18nProvider initialLocale={locale}>{node}</I18nProvider>);
  });
  return {
    host,
    cleanup: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

const LOCALES: Locale[] = ["ko", "en", "ja", "zh"];

// The sentence must actually differ per locale — this catches it if it's stuck in one language.
const CARD_DONE_HINT: Record<Locale, string> = {
  ko: "완료했습니다",
  en: "Finished",
  ja: "完了",
  zh: "已完成",
};
const CARD_BLOCKED_HINT: Record<Locale, string> = {
  ko: "막혔습니다",
  en: "blocked",
  ja: "ブロック",
  zh: "阻塞",
};

test("card_done — all four locales include the card title + an open-card link (R29)", async () => {
  for (const locale of LOCALES) {
    const opened: string[] = [];
    const { host, cleanup } = await render(
      <RoomNoticeMessage
        message={message({
          content: "소피: 주간 보고서",
          notice: {
            kind: "card_done",
            cardId: "card-1",
            cardTitle: "주간 보고서",
            boardSlug: "deskrpg-ch",
            npcName: "소피",
          },
        })}
        onOpenCard={(cardId, boardSlug) => opened.push(`${cardId}@${boardSlug}`)}
      />,
      locale,
    );
    const text = host.textContent ?? "";
    assert.ok(text.includes("주간 보고서"), `${locale}: 카드 제목이 문장에 없다`);
    assert.ok(text.includes(CARD_DONE_HINT[locale]), `${locale}: 로케일 문장이 아니다 — ${text}`);
    assert.ok(!text.includes("소피: 주간"), `${locale}: system 접두가 붙은 content 를 그대로 썼다`);
    const button = host.querySelector("button");
    assert.ok(button, `${locale}: 카드 열기 링크가 없다`);
    await act(async () => button!.click());
    assert.deepEqual(opened, ["card-1@deskrpg-ch"]);
    await cleanup();
  }
});

test("card_blocked — all four locales show a blocked sentence (R29)", async () => {
  for (const locale of LOCALES) {
    const { host, cleanup } = await render(
      <RoomNoticeMessage
        message={message({
          notice: {
            kind: "card_blocked",
            cardId: "card-2",
            cardTitle: "Deploy",
            boardSlug: "b",
            npcName: "Sophie",
          },
        })}
      />,
      locale,
    );
    const text = host.textContent ?? "";
    assert.ok(text.includes("Deploy"), `${locale}: 카드 제목이 없다`);
    assert.ok(
      text.includes(CARD_BLOCKED_HINT[locale]),
      `${locale}: 로케일 문장이 아니다 — ${text}`,
    );
    assert.equal(host.querySelector("button"), null, "핸들러가 없으면 링크도 없다");
    assert.equal(
      host.querySelector("[data-room-notice]")?.getAttribute("data-room-notice"),
      "card_blocked",
    );
    await cleanup();
  }
});

const CARD_REVIEW_HINT: Record<string, string> = {
  ko: "확인",
  en: "review",
  ja: "確認",
  zh: "确认",
};

test("card_review — all four locales show a review-request sentence + an open-card link", async () => {
  for (const locale of LOCALES) {
    const opened: string[] = [];
    const { host, cleanup } = await render(
      <RoomNoticeMessage
        message={message({
          notice: {
            kind: "card_review",
            cardId: "card-3",
            cardTitle: "계약서 검토",
            boardSlug: "deskrpg-ch",
            npcName: "소피",
          },
        })}
        onOpenCard={(cardId, boardSlug) => opened.push(`${cardId}@${boardSlug}`)}
      />,
      locale,
    );
    const text = host.textContent ?? "";
    assert.ok(text.includes("계약서 검토"), `${locale}: 카드 제목이 없다`);
    assert.ok(text.includes(CARD_REVIEW_HINT[locale]), `${locale}: 로케일 문장이 아니다 — ${text}`);
    assert.equal(
      host.querySelector("[data-room-notice]")?.getAttribute("data-room-notice"),
      "card_review",
    );
    const button = host.querySelector("button");
    assert.ok(button, `${locale}: 카드 열기 링크가 없다`);
    await act(async () => button!.click());
    assert.deepEqual(opened, ["card-3@deskrpg-ch"]);
    await cleanup();
  }
});

test("approval_requested — a button before the decision, the result after", async () => {
  for (const locale of LOCALES) {
    const opened: string[] = [];
    const pending = await render(
      <RoomNoticeMessage
        message={message({
          notice: {
            kind: "approval_requested",
            approvalId: "ap-1",
            title: "계약 검토 묶음",
            npcName: "소피",
            targetCount: 3,
          },
        })}
        onOpenApproval={(id) => opened.push(id)}
      />,
      locale,
    );
    assert.ok(
      (pending.host.textContent ?? "").includes("계약 검토 묶음"),
      `${locale}: 제목이 없다`,
    );
    const button = pending.host.querySelector("button");
    assert.ok(button, `${locale}: 승인 열기 버튼이 없다`);
    await act(async () => button!.click());
    assert.deepEqual(opened, ["ap-1"]);
    await pending.cleanup();

    const resolved = await render(
      <RoomNoticeMessage
        message={message({
          notice: {
            kind: "approval_requested",
            approvalId: "ap-1",
            title: "계약 검토 묶음",
            npcName: "소피",
            targetCount: 3,
            resolved: { decision: "approved", by: "u1", at: "2026-09-21T00:00:00.000Z" },
          },
        })}
        onOpenApproval={() => assert.fail("결정된 알림에는 버튼이 없어야 한다")}
      />,
      locale,
    );
    assert.equal(
      resolved.host.querySelector("button"),
      null,
      `${locale}: 결정 뒤에도 버튼이 남았다`,
    );
    assert.ok(resolved.host.querySelector("[data-approval-resolved]"), `${locale}: 결과 줄이 없다`);
    await resolved.cleanup();
  }
});

test("meeting_outcome — a 'register as project' button before registering, the result after", async () => {
  for (const locale of LOCALES) {
    const opened: string[] = [];
    const notice = {
      kind: "meeting_outcome" as const,
      minutesId: "min-1",
      topic: "가격 개편",
      followUpCount: 3,
      recommended: true,
    };
    const pending = await render(
      <RoomNoticeMessage message={message({ notice })} onOpenMinutes={(id) => opened.push(id)} />,
      locale,
    );
    const text = pending.host.textContent ?? "";
    assert.ok(text.includes("가격 개편"), `${locale}: 회의 주제가 없다`);
    assert.ok(text.includes("3"), `${locale}: 후속 업무 개수가 없다`);
    const button = pending.host.querySelector("[data-meeting-outcome-open]");
    assert.ok(Boolean(button), `${locale}: 등록 버튼이 없다`);
    await act(async () => (button as HTMLElement).click());
    assert.deepEqual(opened, ["min-1"]);
    await pending.cleanup();

    const resolved = await render(
      <RoomNoticeMessage
        message={message({
          notice: {
            ...notice,
            resolved: {
              boardSlug: "b",
              tenant: null,
              taskCount: 2,
              by: "u1",
              at: "2026-09-21T00:00:00.000Z",
            },
          },
        })}
        onOpenMinutes={(id) => opened.push(id)}
      />,
      locale,
    );
    assert.ok(
      Boolean(resolved.host.querySelector("[data-meeting-outcome-resolved]")),
      `${locale}: 등록 결과 줄이 없다`,
    );
    // The minutes can still be opened after registering — it just no longer suggests "register" again.
    const after = resolved.host.querySelector("[data-meeting-outcome-open]");
    assert.equal(after?.getAttribute("data-meeting-outcome-open"), "view", `${locale}`);
    await resolved.cleanup();
  }
});

test("meeting_outcome — renders no button when there is nothing to open", async () => {
  const view = await render(
    <RoomNoticeMessage
      message={message({
        notice: {
          kind: "meeting_outcome",
          minutesId: "min-2",
          topic: "가격 개편",
          followUpCount: 1,
          recommended: false,
        },
      })}
    />,
    "ko",
  );
  assert.equal(view.host.querySelectorAll("button").length, 0);
  await view.cleanup();
});

test("cron_result — job name in the header, content as-is for the body, a failure badge on error, and an open-history link (R30)", async () => {
  for (const locale of LOCALES) {
    const opened: string[] = [];
    const { host, cleanup } = await render(
      <RoomNoticeMessage
        message={message({
          senderKind: "system",
          senderId: null,
          content: "결과 본문 라인",
          notice: {
            kind: "cron_result",
            jobId: "job-9",
            jobName: "아침 브리핑",
            npcName: "소피",
            status: "error",
          },
        })}
        onOpenCronJob={(jobId) => opened.push(jobId)}
      />,
      locale,
    );
    const text = host.textContent ?? "";
    assert.ok(text.includes("아침 브리핑"), `${locale}: 잡 이름이 헤더에 없다`);
    assert.ok(text.includes("결과 본문 라인"), `${locale}: 본문이 그대로 나오지 않는다`);
    assert.ok(
      host.querySelector('[data-testid="notice-cron-failed"]'),
      `${locale}: 실패 배지가 없다`,
    );
    const button = host.querySelector("button");
    assert.ok(button, `${locale}: 이력 열기 링크가 없다`);
    await act(async () => button!.click());
    assert.deepEqual(opened, ["job-9"]);
    await cleanup();
  }
});

test("cron_result ok — no failure badge", async () => {
  const { host, cleanup } = await render(
    <RoomNoticeMessage
      message={message({
        content: "ok body",
        notice: { kind: "cron_result", jobId: "j", jobName: "n", npcName: "소피", status: "ok" },
      })}
    />,
    "ko",
  );
  assert.equal(host.querySelector('[data-testid="notice-cron-failed"]'), null);
  assert.ok((host.textContent ?? "").includes("ok body"));
  await cleanup();
});

test("an unknown notice.kind — falls back to content, no link", async () => {
  const { host, cleanup } = await render(
    <RoomNoticeMessage
      message={message({
        content: "raw fallback",
        // The case of an old client encountering a kind the server added later.
        notice: { kind: "something_new" } as unknown as RoomMessage["notice"],
      })}
      onOpenCard={() => assert.fail("호출되면 안 된다")}
      onOpenCronJob={() => assert.fail("호출되면 안 된다")}
    />,
    "en",
  );
  assert.ok((host.textContent ?? "").includes("raw fallback"));
  assert.equal(host.querySelector("button"), null);
  assert.equal(
    host.querySelector("[data-room-notice]")?.getAttribute("data-room-notice"),
    "unknown",
  );
  await cleanup();
});

test("cron_result with an empty body — the viewer's locale says the run failed or had no result", async () => {
  const cases: Array<{ status: "ok" | "error"; locale: Locale; text: string }> = [
    { status: "error", locale: "ja", text: "実行失敗" },
    { status: "ok", locale: "ja", text: "結果なし" },
    { status: "error", locale: "ko", text: "실행 실패" },
    { status: "ok", locale: "en", text: "No result" },
    { status: "error", locale: "zh", text: "执行失败" },
  ];
  for (const { status, locale, text } of cases) {
    const { host, cleanup } = await render(
      <RoomNoticeMessage
        message={message({
          content: "",
          notice: { kind: "cron_result", jobId: "j", jobName: "n", npcName: "소피", status },
        })}
      />,
      locale,
    );
    assert.ok((host.textContent ?? "").includes(text), `${status}/${locale}: ${host.textContent}`);
    await cleanup();
  }
});

test("cron_result from before the change — an old Korean body is shown as stored", async () => {
  const { host, cleanup } = await render(
    <RoomNoticeMessage
      message={message({
        content: "실행 실패",
        notice: { kind: "cron_result", jobId: "j", jobName: "n", npcName: "소피", status: "error" },
      })}
    />,
    "ja",
  );
  const text = host.textContent ?? "";
  assert.ok(text.includes("실행 실패"));
  assert.ok(!text.includes("実行失敗"));
  await cleanup();
});
