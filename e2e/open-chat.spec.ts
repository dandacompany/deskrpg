import { test, expect } from "@playwright/test";
import { enterFirstChannel, ensureTwoHermesNpcs } from "./helpers";

test.describe("map chat", () => {
  test("naming two NPCs together makes both answer", async ({ page }) => {
    test.setTimeout(180_000);
    await enterFirstChannel(page);
    const names = await ensureTwoHermesNpcs(page);
    expect(names.length).toBeGreaterThanOrEqual(2);

    // The map chat panel is collapsed by default — open it with the "채팅 열기" toggle.
    await page.getByTitle("채팅 열기").click();

    // Wait until the channel chat input (placeholder: "메시지를 입력하세요...") appears.
    const input = page.getByPlaceholder("메시지를 입력하세요...");
    await input.waitFor({ state: "visible" });

    const before = await page.locator("[data-chat-bubble]").count();
    const npcBubbles = page.locator('[data-chat-bubble="npc"]');
    const npcBefore = await npcBubbles.count();

    await input.fill(`@[${names[0]}] @[${names[1]}] 점심 뭐 먹을까요?`);
    await input.press("Enter");

    // 1 human message + 2 NPC messages = at least 3 more.
    await expect
      .poll(async () => (await page.locator("[data-chat-bubble]").count()) - before, {
        timeout: 150_000,
        intervals: [2000],
      })
      .toBeGreaterThanOrEqual(3);

    // Collect every NPC bubble created by this send (however many times each spoke) and check that both NPC
    // names appear. A single human message already increases the [data-chat-bubble] count,
    // so the count alone cannot guarantee "both answered". Looking only at the last N could
    // fail falsely when one NPC speaks twice through a mention chain (allowed behavior), so
    // look at everything after "the number of NPC bubbles before this send".
    const newNpcTexts = (await npcBubbles.allInnerTexts()).slice(npcBefore);
    const tail = newNpcTexts.join("\n");
    expect(tail).toContain(names[0]);
    expect(tail).toContain(names[1]);
  });
});
