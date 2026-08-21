import type { Page } from "@playwright/test";

export const DEV_LOGIN_ID = process.env.DESKRPG_E2E_LOGIN_ID ?? "devadmin";
export const DEV_PASSWORD = process.env.DESKRPG_E2E_PASSWORD ?? "deskrpg-e2e-2026";

/**
 * 로그인 → 캐릭터 선택 → 채널 입장까지. 맵이 그려지면 반환한다.
 *
 * 로그인은 폼이 아니라 API 로 한다. 이 스위트가 검증하는 것은 대화이지 로그인 화면이
 * 아니고, 매 테스트가 폼을 거치면 느리고 취약해진다. (실측 메모: 쿠키가 없는 새
 * 브라우저 프로필로 /auth 를 열면 페이지가 "인증 확인 중..." 에서 멈춘 채 hydrate 되지
 * 않아 폼 자체가 렌더되지 않았다 — DOM 에 React fiber 가 붙지 않고 부트스트랩
 * useEffect 가 끝내 돌지 않는다. 그 문제는 이 하네스와 별개로 따로 다룬다.)
 */
export async function enterFirstChannel(page: Page): Promise<void> {
  await login(page);

  // 캐릭터 카드·채널 카드 모두 제목(h3)이 클릭 대상이다. 스프라이트는 <img> 가 아니라
  // 캔버스로 그려지므로 이미지로 잡으면 안 된다.
  await page.goto("/characters");
  await page.locator("h3").first().click();
  await page.waitForURL(/\/channels/);

  await page.locator("h3").first().click();
  await page.waitForURL(/\/game\?/);

  // Phaser 캔버스가 붙고 게임 루프가 실제로 도는 것까지 기다린다.
  await page.locator("canvas").first().waitFor({ state: "visible" });
  await waitForGameLoop(page);
}

/** 세션 쿠키를 컨텍스트에 심는다. */
export async function login(page: Page): Promise<void> {
  const res = await page.request.post("/api/auth/login", {
    data: { loginId: DEV_LOGIN_ID, password: DEV_PASSWORD },
  });
  if (!res.ok()) {
    throw new Error(
      `개발 계정 로그인 실패 (${res.status()}). DESKRPG_E2E_LOGIN_ID / `
        + `DESKRPG_E2E_PASSWORD 를 확인하십시오. 응답: ${(await res.text()).slice(0, 200)}`,
    );
  }
}

/**
 * requestAnimationFrame 이 실제로 도는지 확인한다.
 *
 * headed 로 띄우면 창이 가려지는 순간 Chrome 이 rAF 를 초당 1프레임으로 스로틀하고,
 * Phaser 루프가 멈춰 캐릭터가 영영 이동하지 않는다. document.visibilityState 는 그때도
 * "visible" 이라 코드로는 안 보인다 — 그래서 상태 플래그가 아니라 프레임을 직접 센다.
 */
export async function waitForGameLoop(page: Page, minFps = 10): Promise<number> {
  const fps = await page.evaluate(async () => {
    const t0 = performance.now();
    let frames = 0;
    await new Promise<void>((resolve) => {
      const tick = () => {
        frames++;
        if (performance.now() - t0 < 1000) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
    return frames;
  });
  if (fps < minFps) {
    throw new Error(
      `게임 루프가 ${fps}fps 로 돌고 있습니다(최소 ${minFps} 필요). 창이 가려져 Chrome 이 `
        + "requestAnimationFrame 을 스로틀하는 상태입니다 — headless 로 실행하거나 "
        + "브라우저 창을 앞으로 올리십시오.",
    );
  }
  return fps;
}

/** 상단 로스터에서 NPC 를 골라 대화를 시작한다. 대화창이 열리면 반환한다. */
export async function openNpcDialog(page: Page, npcName: string): Promise<void> {
  await page.locator("button").filter({ hasText: /NPC.*\d|명/ }).last().click();
  await page.locator("button, div").filter({ hasText: npcName }).last().click();
  await page.getByRole("button", { name: "대화하기" }).click();

  // NPC 옆까지 걸어간 뒤에야 대화창이 열린다 — 이동 시간을 감안한다.
  await page.locator('[data-chat-bubble], textarea, input[type="text"]').last().waitFor({ timeout: 60_000 });
}

/** 메시지를 보내고 NPC 답변 한 건이 끝날 때까지 기다린 뒤 그 텍스트를 돌려준다. */
export async function sendAndAwaitReply(page: Page, message: string): Promise<string> {
  const before = await page.locator('[data-chat-bubble="npc"]').count();

  const input = page.locator('textarea, input[type="text"]').last();
  await input.fill(message);
  await input.press("Enter");

  const reply = page.locator('[data-chat-bubble="npc"]').nth(before);
  await reply.waitFor({ timeout: 150_000 });
  // 스트리밍이 끝나야 최종 텍스트다.
  await reply.locator('xpath=self::*[@data-streaming="false"]').waitFor({ timeout: 150_000 });
  return (await reply.innerText()).trim();
}

/**
 * 텍스트가 자기 자신을 정확히 두 번 담고 있는지.
 *
 * Hermes 의 `_thinking` 툴이 완성된 답변 전체를 tool.progress 로 한 번 더 보내는데,
 * 그걸 본문 스트림에 섞으면 결과가 정확히 2배가 된다. 실제로 그렇게 났던 회귀다.
 */
export function isDoubled(text: string): boolean {
  const t = text.replace(/\s+/g, "");
  if (t.length < 2 || t.length % 2 !== 0) return false;
  const half = t.length / 2;
  return t.slice(0, half) === t.slice(half);
}
