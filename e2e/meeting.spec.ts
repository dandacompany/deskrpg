import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import {
  enterFirstChannel,
  ensureTwoHermesNpcs,
  openNpcDialog,
  sendAndAwaitReply,
  isDoubled,
} from "./helpers";

// 회의는 NPC 한 명으로는 검증할 수 없다 — 검증 대상이 "발언권이 참가자 사이를 도는가"이기
// 때문이다. ensureTwoHermesNpcs 가 두 번째를 준비한다.
//
// 실행 전제는 npc-dm.spec.ts 와 같다(e2e/README.md 참조). 회의는 NPC 여러 명이 순서대로
// 발언하므로 1:1 보다 오래 걸린다.

/**
 * 회의실 탭으로 들어가 참가자를 고르고 토론을 시작한다.
 *
 * 셀렉터 주의: 상단 버튼 레이블에는 배지 숫자가 붙는다("회의실 0", "뒤로 0"). 이름을
 * 정확 일치로 잡으면 숫자가 바뀌는 순간 조용히 멈춘다 — 정규식으로 받는다.
 */
async function startMeeting(page: Page, npcNames: string[], topic: string): Promise<void> {
  await page.getByRole("button", { name: /회의실/ }).click();

  // 참가자는 기본으로 전원 선택돼 있다("· 2/2 NPC"). 그래도 명시적으로 확인한다 —
  // 기본값이 바뀌면 "회의는 돌았지만 우리가 고른 NPC 는 아니었다"가 되기 때문이다.
  await page.getByRole("button", { name: /진행 설정/ }).click();
  await page.getByText("참여 NPC").waitFor();
  for (const name of npcNames) {
    const box = page.locator("label").filter({ hasText: name }).locator('input[type="checkbox"]');
    if (!(await box.isChecked())) await box.check();
  }

  await page.getByPlaceholder("회의 주제를 입력하세요").fill(topic);
  await page.getByRole("button", { name: "회의 시작" }).click();
}

/** NPC 발언이 targetCount 건 쌓일 때까지 기다린 뒤 [화자, 내용] 목록을 돌려준다. */
async function collectNpcTurns(page: Page, targetCount: number): Promise<Array<[string, string]>> {
  const turns = page.locator('[data-meeting-message="npc"]');
  await expect(turns).toHaveCount(targetCount, { timeout: 300_000 });
  const out: Array<[string, string]> = [];
  for (let i = 0; i < (await turns.count()); i++) {
    const t = turns.nth(i);
    out.push([(await t.getAttribute("data-sender")) ?? "", (await t.innerText()).trim()]);
  }
  return out;
}

test.describe("회의", () => {
  // 두 NPC 가 각자 한 턴씩 도는 데 에이전트 기동까지 포함하면 1:1 보다 훨씬 오래 걸린다.
  test.setTimeout(600_000);

  test("두 NPC 가 번갈아 발언한다 — 한 명이 독점하지 않는다", async ({ page }) => {
    await enterFirstChannel(page);
    const npcNames = await ensureTwoHermesNpcs(page);
    expect(npcNames.length, "회의에는 Hermes NPC 가 둘 필요합니다").toBeGreaterThanOrEqual(2);

    await startMeeting(page, npcNames.slice(0, 2), "점심 메뉴를 하나만 정해 주세요. 짧게 말하세요.");

    const turns = await collectNpcTurns(page, 2);
    const speakers = new Set(turns.map(([who]) => who));

    expect(
      speakers.size,
      `발언권이 돌지 않았습니다. 발언자: ${turns.map(([w]) => w).join(" → ")}`,
    ).toBeGreaterThanOrEqual(2);

    for (const [who, text] of turns) {
      expect(text.length, `${who} 의 발언이 비어 있습니다`).toBeGreaterThan(0);
      expect(isDoubled(text), `${who} 의 발언이 두 번 반복됩니다:\n${text}`).toBe(false);
    }
  });

  test("회의 진행 텍스트가 1:1 대화창으로 새지 않는다", async ({ page }) => {
    await enterFirstChannel(page);
    const npcNames = await ensureTwoHermesNpcs(page);
    const [first] = npcNames;

    // 회의를 돌려 NPC 세션에 다자 대화 맥락을 쌓는다.
    await startMeeting(page, npcNames.slice(0, 2), "회의 격리 확인용 주제입니다. 한 문장으로 답하세요.");
    const turns = await collectNpcTurns(page, 2);

    // 회의를 끝내고 사무실로 돌아온다.
    await page.getByRole("button", { name: /회의 종료|중단|정지/ }).first().click().catch(() => {});
    await page.getByRole("button", { name: /뒤로/ }).first().click().catch(() => {});

    // 같은 NPC 와 1:1 로 말한다. 회의 트랜스크립트는 엔진이 소유하고 1:1 은 별도의
    // 영속 세션을 쓰므로, 회의 발언이 여기 나타나면 세션이 섞인 것이다.
    await page.goto(page.url().replace(/#.*$/, ""));
    await openNpcDialog(page, first);
    const dm = await sendAndAwaitReply(page, "지금 이 대화는 1:1 입니다. '확인'이라고만 답하세요.");

    for (const [, meetingText] of turns) {
      const fingerprint = meetingText.replace(/\s+/g, "").slice(0, 12);
      if (fingerprint.length < 6) continue;
      expect(
        dm.replace(/\s+/g, ""),
        `1:1 답변에 회의 발언이 섞여 나왔습니다 — 세션 격리가 깨졌습니다.\n회의: ${meetingText}\n1:1: ${dm}`,
      ).not.toContain(fingerprint);
    }
  });
});
