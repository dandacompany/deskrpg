import { test, expect } from "@playwright/test";
import { login } from "./helpers";

// Explicit opt-in: performs real conversations and card creation, runs and rework.
// Supply an existing office game path and NPC name. Never use the public landing site.
const enabled = process.env.DESKRPG_E2E_LIVE_WORKFLOW === "1";
const gamePath = process.env.DESKRPG_E2E_GAME_PATH;
const npc = process.env.DESKRPG_E2E_NPC;

test("office work: request, verify registration, review, revise, and acknowledge", async ({
  page,
}, info) => {
  test.skip(!enabled, "Set DESKRPG_E2E_LIVE_WORKFLOW=1 to authorize real agent work");
  test.setTimeout(600_000);
  expect(new URL(String(info.project.use.baseURL)).hostname).toBe("stage.deskrpg.com");
  expect(gamePath).toMatch(/^\/game\?/);
  expect(npc).toBeTruthy();
  const title = `[workflow-check ${Date.now()}] 주간 업무 점검 안내문`;
  const timings: Record<string, number> = {};
  const start = Date.now();
  await login(page);
  await page.goto(gamePath!);
  await page.getByRole("button", { name: `${npc} 대화`, exact: true }).click();
  const panel = page.getByRole("complementary", { name: `${npc} 채팅`, exact: true });
  const chatTab = panel.getByRole("tab", { name: "대화", exact: true });
  const replies = panel.locator('[data-chat-bubble="npc"][data-streaming="false"]');

  async function ask(message: string) {
    await chatTab.click();
    const before = await replies.count();
    await panel.getByRole("textbox").fill(message);
    await panel.getByRole("textbox").press("Enter");
    await expect(replies).toHaveCount(before + 1, { timeout: 150_000 });
    return (await replies.last().innerText()).trim();
  }

  try {
    await ask(
      `${title} — 검증용 업무입니다. 외부 검색·발송·게시 없이 완료한 일, 막힌 일, 다음 주 할 일을 점검하는 한국어 3문장 안내문을 작성해 주세요. 기존 파일과 설정은 변경하지 마세요.`,
    );
    timings.requestMs = Date.now() - start;
    await panel.getByRole("button", { name: "카드로 등록", exact: true }).last().click();
    const editor = page.getByRole("dialog", { name: "카드 만들기", exact: true });
    await editor.getByLabel("제목", { exact: false }).fill(title);
    await editor
      .getByLabel("완료 조건", { exact: false })
      .fill(
        "완료한 일·막힌 일·다음 주 할 일을 점검하는 한국어 3문장. 외부 검색·발송·게시와 기존 파일·설정 변경 없이 카드 결과에 남기고 검토를 요청하세요. 사람의 승인 전에 완료 처리하지 마세요.",
      );
    await editor.getByRole("button", { name: "만들기", exact: true }).click();
    const detail = page.getByRole("complementary", { name: "카드 상세", exact: true });
    await expect(detail).toContainText(title);
    timings.registeredMs = Date.now() - start;
    // A real worker run result must arrive in review status. A completion claim in conversation is not evidence.
    await expect(detail.getByLabel("상태", { exact: true })).toHaveValue("review", {
      timeout: 240_000,
    });
    await detail
      .getByPlaceholder("재작업 사유 (필수)")
      .fill(
        "둘째 문장에는 담당자와 필요한 지원을, 셋째 문장에는 마감일을 포함하세요. 수정한 세 문장을 카드 결과로 남기고 다시 검토를 요청하세요. 외부 발송과 파일·설정 변경은 하지 마세요.",
      );
    await detail.getByRole("button", { name: "재작업 요청", exact: true }).click();
    await expect(detail.getByLabel("상태", { exact: true })).not.toHaveValue("review");
    await expect(detail.getByLabel("상태", { exact: true })).toHaveValue("review", {
      timeout: 240_000,
    });
    const result = detail
      .locator("section")
      .filter({ has: page.getByText("결과", { exact: true }) })
      .locator("pre");
    await expect(result).toContainText("담당자");
    await expect(result).toContainText("마감일");
    timings.revisedMs = Date.now() - start;
    await detail.getByRole("button", { name: "승인", exact: true }).click();
    await expect(detail.getByLabel("상태", { exact: true })).toHaveValue("done");
    timings.completedMs = Date.now() - start;
  } finally {
    await info.attach("workflow-timings", {
      body: JSON.stringify({ title, timings }),
      contentType: "application/json",
    });
  }
});
