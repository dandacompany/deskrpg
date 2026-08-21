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
async function startMeeting(
  page: Page,
  npcNames: string[],
  topic: string,
): Promise<void> {
  await page.getByRole("button", { name: /회의실/ }).click();

  // 참가자는 기본으로 전원 선택돼 있다("· 2/2 NPC"). 그래도 명시적으로 확인한다 —
  // 기본값이 바뀌면 "회의는 돌았지만 우리가 고른 NPC 는 아니었다"가 되기 때문이다.
  await page.getByRole("button", { name: /진행 설정/ }).click();
  await page.getByText("참여 NPC").waitFor();
  for (const name of npcNames) {
    const box = page
      .locator("label")
      .filter({ hasText: name })
      .locator('input[type="checkbox"]');
    if (!(await box.isChecked())) await box.check();
  }

  // 턴 상한을 최소(5)로 낮춘다. 기본 20 이면 회의가 몇 분씩 돌고, 상한에 닿는 순간
  // MeetingRoom 이 발언 목록을 결과 화면으로 교체해 버려 수집할 것이 사라진다.
  // 검증 대상은 "발언권이 도는가"이지 회의의 길이가 아니다.
  await page.locator('input[type="range"]').first().fill("5");

  await page.getByPlaceholder("회의 주제를 입력하세요").fill(topic);
  await page.getByRole("button", { name: "회의 시작" }).click();
}

/**
 * NPC 발언이 targetCount 건 쌓일 때까지 기다린 뒤 [화자, 내용] 목록을 돌려준다.
 *
 * 회의가 턴 상한(기본 20)에 도달하면 MeetingRoom 은 발언 목록을 결과 화면으로 **교체**한다
 * — 그러면 [data-meeting-message] 가 통째로 사라진다. 단순히 toHaveCount 로 기다리면
 * 회의가 먼저 끝나 버린 경우 영영 0개를 보며 타임아웃한다(실측: 격리 시나리오가 이렇게
 * 5분을 기다리다 죽었는데, 정작 회의는 20턴을 다 돌고 요약까지 남긴 뒤였다).
 * 그래서 카운트가 아니라 폴링으로 잡고, 회의가 끝나면 그 시점까지 모인 것을 돌려준다.
 */
async function collectNpcTurns(page: Page, targetCount: number): Promise<Array<[string, string]>> {
  const turns = page.locator('[data-meeting-message="npc"]');
  const deadline = Date.now() + 300_000;
  let best: Array<[string, string]> = [];

  while (Date.now() < deadline) {
    const count = await turns.count();
    if (count > best.length) {
      const snapshot: Array<[string, string]> = [];
      for (let i = 0; i < count; i++) {
        const t = turns.nth(i);
        snapshot.push([(await t.getAttribute("data-sender")) ?? "", (await t.innerText()).trim()]);
      }
      best = snapshot;
    }
    if (best.length >= targetCount) return best;

    // 회의가 끝나면 발언 목록이 사라진다 — 더 기다려도 늘지 않는다.
    //
    // 단, 발언을 하나도 못 본 상태에서 보이는 "종료" 는 **이전 회의의 결과 화면**이다.
    // 같은 채널에서 시나리오를 연달아 돌리면 앞 회의의 결과가 그대로 남아 있고, 그걸
    // 종료로 읽으면 새 회의가 첫 턴을 내기도 전에 8초 만에 포기한다(실측).
    if (best.length > 0) {
      const ended = await page.getByText("회의가 종료되었습니다").isVisible().catch(() => false);
      if (ended) break;
    }
    await page.waitForTimeout(1000);
  }

  expect(
    best.length,
    `NPC 발언을 ${targetCount}건 모으지 못했습니다(모은 것: ${best.length}건). `
      + "회의가 턴을 돌리지 못했거나, 발언이 화면에 붙지 않았습니다.",
  ).toBeGreaterThanOrEqual(targetCount);
  return best;
}

/**
 * 회의가 끝날 때까지 기다린 뒤, 결과 화면의 텍스트에서 1:1 오염 검사에 쓸 지문을 뽑는다.
 *
 * 발언 말풍선을 세지 않는 이유: 회의가 턴 상한에 닿으면 MeetingRoom 이 발언 목록을 결과
 * 화면으로 교체하므로, 짧은 회의에서는 관측 창 자체가 사라진다(실측: 5턴 회의가 20초에
 * 끝나 폴링이 한 번도 0 이상을 보지 못했다). 결과 화면의 주요 주제·결론은 회의가 실제로
 * 오간 내용에서 나온 것이라 오염 검사의 지문으로 충분하다.
 */
async function waitForMeetingEnd(page: Page): Promise<Array<[string, string]>> {
  await page.getByText("회의가 종료되었습니다").waitFor({ timeout: 300_000 });

  const summary = page.locator("text=회의가 종료되었습니다").locator("xpath=..");
  const text = (await summary.innerText().catch(() => "")).trim();
  expect(text.length, "회의 결과 화면이 비어 있습니다 — 회의가 돌지 않았습니다").toBeGreaterThan(0);

  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length >= 8)
    .map((line) => ["회의", line] as [string, string]);
}

test.describe("회의", () => {
  // 두 NPC 가 각자 한 턴씩 도는 데 에이전트 기동까지 포함하면 1:1 보다 훨씬 오래 걸린다.
  test.setTimeout(600_000);

  test("두 NPC 가 번갈아 발언한다 — 한 명이 독점하지 않는다", async ({
    page,
  }) => {
    await enterFirstChannel(page);
    const npcNames = await ensureTwoHermesNpcs(page);
    expect(
      npcNames.length,
      "회의에는 Hermes NPC 가 둘 필요합니다",
    ).toBeGreaterThanOrEqual(2);

    await startMeeting(
      page,
      npcNames.slice(0, 2),
      "점심 메뉴를 하나만 정해 주세요. 짧게 말하세요.",
    );

    const turns = await collectNpcTurns(page, 2);
    const speakers = new Set(turns.map(([who]) => who));

    expect(
      speakers.size,
      `발언권이 돌지 않았습니다. 발언자: ${turns.map(([w]) => w).join(" → ")}`,
    ).toBeGreaterThanOrEqual(2);

    for (const [who, text] of turns) {
      expect(text.length, `${who} 의 발언이 비어 있습니다`).toBeGreaterThan(0);
      expect(
        isDoubled(text),
        `${who} 의 발언이 두 번 반복됩니다:\n${text}`,
      ).toBe(false);
    }
  });

  test("회의 진행 텍스트가 1:1 대화창으로 새지 않는다", async ({ page }) => {
    await enterFirstChannel(page);
    const npcNames = await ensureTwoHermesNpcs(page);
    const [first] = npcNames;

    // 회의를 돌려 NPC 세션에 다자 대화 맥락을 쌓는다.
    await startMeeting(
      page,
      npcNames.slice(0, 2),
      "회의 격리 확인용 주제입니다. 한 문장으로 답하세요.",
    );
    // 이 시나리오가 보는 것은 "회의를 돌린 뒤 1:1 이 오염되지 않는가"이지 발언 수집이
    // 아니다. 5턴짜리 회의는 20초면 끝나고, 끝나는 순간 발언 목록이 결과 화면으로
    // 통째로 교체된다 — 발언을 세려 들면 그 짧은 창을 놓치고 아무것도 못 본다.
    // 그래서 회의가 **끝날 때까지** 기다린 뒤, 회의록에서 실제 발언 내용을 가져온다.
    const turns = await waitForMeetingEnd(page);

    // 회의는 턴 상한에 닿아 이미 끝났다 — 따로 종료시킬 필요가 없다.
    //
    // (여기에는 `getByRole("button", { name: /회의 종료|중단|정지/ }).click().catch(...)`
    //  가 있었다. 그런 이름의 버튼은 존재하지 않고 정지는 아이콘 ⏹ 이다. .catch() 는
    //  실패한 **뒤에야** 동작하므로, 없는 버튼마다 expect 타임아웃 120초를 꼬박 기다린
    //  다음 조용히 넘어갔다 — 조용한 실패가 아니라 조용한 지연이었고, 그 둘이 10분
    //  테스트 타임아웃을 채웠다.)

    // 같은 NPC 와 1:1 로 말한다. 회의 트랜스크립트는 엔진이 소유하고 1:1 은 별도의
    // 영속 세션을 쓰므로, 회의 발언이 여기 나타나면 세션이 섞인 것이다.
    // 새로고침하면 사무실 모드로 돌아온다.
    await page.goto(page.url());
    await openNpcDialog(page, first);
    const dm = await sendAndAwaitReply(
      page,
      "지금 이 대화는 1:1 입니다. '확인'이라고만 답하세요.",
    );

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
