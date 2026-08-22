import { test, expect } from "@playwright/test";
import { enterFirstChannel, ensureTwoHermesNpcs } from "./helpers";

test.describe("맵 채팅", () => {
  test("두 NPC 를 함께 지명하면 둘 다 대답한다", async ({ page }) => {
    test.setTimeout(180_000);
    await enterFirstChannel(page);
    const names = await ensureTwoHermesNpcs(page);
    expect(names.length).toBeGreaterThanOrEqual(2);

    // 맵 채팅 패널은 기본적으로 접혀 있다 — "채팅 열기" 토글로 연다.
    await page.getByTitle("채팅 열기").click();

    // 채널 채팅 입력창(placeholder: "메시지를 입력하세요...")까지 뜨는 것을 기다린다.
    const input = page.getByPlaceholder("메시지를 입력하세요...");
    await input.waitFor({ state: "visible" });

    const before = await page.locator("[data-chat-bubble]").count();
    const npcBubbles = page.locator('[data-chat-bubble="npc"]');
    const npcBefore = await npcBubbles.count();

    await input.fill(`@[${names[0]}] @[${names[1]}] 점심 뭐 먹을까요?`);
    await input.press("Enter");

    // 사람 메시지 1건 + NPC 2건 = 최소 3건이 늘어야 한다.
    await expect
      .poll(async () => (await page.locator("[data-chat-bubble]").count()) - before, {
        timeout: 150_000,
        intervals: [2000],
      })
      .toBeGreaterThanOrEqual(3);

    // 이번 전송으로 새로 생긴 NPC 말풍선 전체(이번에 몇 번 말했든)를 모아 두 NPC 이름이
    // 모두 나타나는지 확인한다. 사람 메시지 하나만으로도 [data-chat-bubble] 카운트는
    // 늘어나므로, 카운트만으로는 "둘 다 대답했다"를 보장하지 못한다. 마지막 N개만 보면
    // 한 NPC 가 멘션 체인으로 두 번 말했을 때(허용된 동작) 오탐 실패할 수 있으므로,
    // "이번 전송 이전에 있던 NPC 말풍선 수" 이후 전부를 본다.
    const newNpcTexts = (await npcBubbles.allInnerTexts()).slice(npcBefore);
    const tail = newNpcTexts.join("\n");
    expect(tail).toContain(names[0]);
    expect(tail).toContain(names[1]);
  });
});
