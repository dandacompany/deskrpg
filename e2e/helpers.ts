import type { Page } from "@playwright/test";

export const DEV_LOGIN_ID = process.env.DESKRPG_E2E_LOGIN_ID ?? "devadmin";
export const DEV_PASSWORD = process.env.DESKRPG_E2E_PASSWORD ?? "deskrpg-e2e-2026";

/**
 * Log in → enter the first channel. Returns once the map is drawn. The account must already have a
 * character: /characters is a single-character form now (no card list to click), and /game sends an
 * account without one back there.
 *
 * Login goes through the API, not the form. This suite verifies conversation, not the login
 * screen, and going through the form in every test is slow and brittle. (Measurement note: opening /auth
 * in a fresh browser profile without cookies left the page stuck at "인증 확인 중..." without
 * hydrating, so the form never rendered — no React fiber attached to the DOM and the bootstrap
 * useEffect never ran. That problem is handled separately from this harness.)
 */
export async function enterFirstChannel(page: Page): Promise<void> {
  await login(page);

  // A channel card is clicked by its title (h3), not by its thumbnail.
  await page.goto("/channels");
  await page.locator("[data-channel-id] h3").first().click();
  await page.waitForURL(/\/game\?/);

  // Wait until the 3D canvas is attached and the simulation tick loop is actually running.
  await page.locator("canvas").first().waitFor({ state: "visible" });
  await waitForGameLoop(page);
}

/** Plant the session cookie in the context. */
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
 * Check that requestAnimationFrame actually runs.
 *
 * In headed mode Chrome throttles rAF to 1 frame per second the moment the window is covered,
 * the simulation tick loop stops, and the character never moves. document.visibilityState is still
 * "visible" then, so code cannot see it — which is why we count frames directly instead of a state flag.
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

/** Pick an NPC from the top roster and start a conversation. Returns once the dialog opens. */
export async function openNpcDialog(page: Page, npcName: string): Promise<void> {
  await page
    .locator("button")
    .filter({ hasText: /NPC.*\d|명/ })
    .last()
    .click();
  await page.locator("button, div").filter({ hasText: npcName }).last().click();
  await page.getByRole("button", { name: "대화하기" }).click();

  // The dialog opens only after walking up to the NPC — allow for the travel time.
  await page
    .locator('[data-chat-bubble], textarea, input[type="text"]')
    .last()
    .waitFor({ timeout: 60_000 });
}

/** Send a message, wait for one NPC reply to finish, and return its text. */
export async function sendAndAwaitReply(page: Page, message: string): Promise<string> {
  const before = await page.locator('[data-chat-bubble="npc"]').count();

  const input = page.locator('textarea, input[type="text"]').last();
  await input.fill(message);
  await input.press("Enter");

  const reply = page.locator('[data-chat-bubble="npc"]').nth(before);
  await reply.waitFor({ timeout: 150_000 });
  // The final text exists only after streaming ends.
  await reply.locator('xpath=self::*[@data-streaming="false"]').waitFor({ timeout: 150_000 });
  return (await reply.innerText()).trim();
}

/**
 * Whether the text contains itself exactly twice.
 *
 * Hermes's `_thinking` tool sends the whole finished answer once more as tool.progress;
 * mixing that into the body stream doubles the result exactly. That regression really happened.
 */
export function isDoubled(text: string): boolean {
  const t = text.replace(/\s+/g, "");
  if (t.length < 2 || t.length % 2 !== 0) return false;
  const half = t.length / 2;
  return t.slice(0, half) === t.slice(half);
}

// ---------------------------------------------------------------------------
// Meeting scenario fixtures
// ---------------------------------------------------------------------------

/** Extract the visible channel id from the URL. */
export function channelIdFrom(page: Page): string {
  const id = new URL(page.url()).searchParams.get("channelId");
  if (!id) throw new Error(`채널 id 를 URL 에서 찾지 못했습니다: ${page.url()}`);
  return id;
}

/**
 * Ensure at least two NPCs are bound to Hermes profiles. Returns their names.
 *
 * The point of a meeting is the floor passing between participants, so one NPC cannot verify it.
 * The second NPC is created through the API — walking through the hiring UI is its own scenario,
 * and here we want to see the meeting, not hiring. If there are already two or more,
 * create nothing and use the existing NPCs.
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

  // Pick a profile no NPC uses yet. Profiles hang off a gateway, so
  // find the gateway first.
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
      // Placing them on the same tile gives 409 (tile_already_occupied).
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
