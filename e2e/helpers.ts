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
      `개발 계정 로그인 실패 (${res.status()}). DESKRPG_E2E_LOGIN_ID / ` +
        `DESKRPG_E2E_PASSWORD 를 확인하십시오. 응답: ${(await res.text()).slice(0, 200)}`,
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
      `게임 루프가 ${fps}fps 로 돌고 있습니다(최소 ${minFps} 필요). 창이 가려져 Chrome 이 ` +
        "requestAnimationFrame 을 스로틀하는 상태입니다 — headless 로 실행하거나 " +
        "브라우저 창을 앞으로 올리십시오.",
    );
  }
  return fps;
}

/** 상단 로스터에서 NPC 를 골라 대화를 시작한다. 대화창이 열리면 반환한다. */
export async function openNpcDialog(page: Page, npcName: string): Promise<void> {
  await page
    .locator("button")
    .filter({ hasText: /NPC.*\d|명/ })
    .last()
    .click();
  await page.locator("button, div").filter({ hasText: npcName }).last().click();
  await page.getByRole("button", { name: "대화하기" }).click();

  // NPC 옆까지 걸어간 뒤에야 대화창이 열린다 — 이동 시간을 감안한다.
  await page
    .locator('[data-chat-bubble], textarea, input[type="text"]')
    .last()
    .waitFor({ timeout: 60_000 });
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

// ---------------------------------------------------------------------------
// 회의 시나리오 준비물
// ---------------------------------------------------------------------------

/** 화면에 보이는 채널 id 를 URL 에서 뽑는다. */
export function channelIdFrom(page: Page): string {
  const id = new URL(page.url()).searchParams.get("channelId");
  if (!id) throw new Error(`채널 id 를 URL 에서 찾지 못했습니다: ${page.url()}`);
  return id;
}

/**
 * Hermes 프로필이 묶인 NPC 가 최소 두 명 있게 만든다. 이름 배열을 돌려준다.
 *
 * 회의는 발언권이 참가자 사이를 도는 것이 핵심이라 한 명으로는 검증할 수 없다.
 * 두 번째 NPC 는 API 로 만든다 — 채용 UI 를 밟는 것은 그 자체로 별개의 시나리오이고,
 * 여기서는 회의를 보려는 것이지 채용을 보려는 것이 아니다. 이미 두 명 이상이면
 * 아무것도 만들지 않고 기존 NPC 를 그대로 쓴다.
 */
export async function ensureTwoHermesNpcs(page: Page): Promise<string[]> {
  const channelId = channelIdFrom(page);

  const listRes = await page.request.get(`/api/npcs?channelId=${channelId}`);
  const { npcs = [] } = (await listRes.json()) as {
    npcs?: {
      name: string;
      adapterType: string;
      hermesProfileId: string | null;
      positionX: number;
      positionY: number;
    }[];
  };
  const hermesNpcs = npcs.filter((n) => n.adapterType === "hermes" && n.hermesProfileId);
  if (hermesNpcs.length >= 2) return hermesNpcs.map((n) => n.name);
  if (hermesNpcs.length === 0) {
    throw new Error(
      "Hermes 프로필이 묶인 NPC 가 하나도 없습니다. 회의 시나리오는 최소 한 명을 전제로 " +
        "두 번째만 만들어 줍니다 — 먼저 UI 에서 NPC 를 한 명 고용하십시오.",
    );
  }

  // 아직 아무 NPC 도 쓰지 않는 프로필을 고른다. 프로필은 게이트웨이에 매달려 있으므로
  // 게이트웨이를 먼저 찾는다.
  const gwRes = await page.request.get("/api/gateways");
  if (!gwRes.ok()) {
    throw new Error(`게이트웨이 목록을 읽지 못했습니다 (${gwRes.status()}).`);
  }
  const gwBody = (await gwRes.json()) as { gateways?: { id: string }[] };
  const gateways = gwBody.gateways ?? [];
  if (gateways.length === 0) {
    throw new Error("연결된 게이트웨이가 없습니다 — 먼저 Hermes 게이트웨이를 등록하십시오.");
  }

  let free: { id: string; profileName: string } | undefined;
  for (const gw of gateways) {
    const profRes = await page.request.get(`/api/gateways/${gw.id}/profiles`);
    if (!profRes.ok()) continue;
    const { profiles = [] } = (await profRes.json()) as {
      profiles?: { id: string; profileName: string; inUse?: boolean }[];
    };
    free = profiles.find((p) => !p.inUse);
    if (free) break;
  }
  if (!free) {
    throw new Error(
      "남는 Hermes 프로필이 없습니다. 회의에는 서로 다른 프로필을 쓰는 NPC 가 둘 필요합니다 " +
        "— 게이트웨이에서 프로필을 하나 더 연결하십시오.",
    );
  }

  const seed = hermesNpcs[0];
  const created = await page.request.post("/api/npcs", {
    data: {
      channelId,
      name: `E2E-${free.profileName}`,
      // 같은 타일에 놓으면 409(tile_already_occupied)가 난다.
      positionX: seed.positionX + 2,
      positionY: seed.positionY,
      direction: "down",
      appearance: (npcs as unknown as { appearance: unknown }[])[0].appearance,
      identity: "회의에서 짧고 분명하게 의견을 말한다. 답변은 두 문장을 넘기지 않는다.",
      adapterType: "hermes",
      hermesProfileId: free.id,
      locale: "ko",
    },
  });
  if (!created.ok()) {
    throw new Error(
      `두 번째 NPC 생성 실패 (${created.status()}): ${(await created.text()).slice(0, 200)}`,
    );
  }
  const body = (await created.json()) as { npc: { name: string } };
  return [seed.name, body.npc.name];
}
