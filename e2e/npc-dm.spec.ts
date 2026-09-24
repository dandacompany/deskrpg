import { test, expect } from "@playwright/test";
import {
  enterFirstChannel,
  openNpcDialog,
  sendAndAwaitReply,
  isDoubled,
  waitForGameLoop,
} from "./helpers";

// Preconditions: `npm run dev` is up, the local Hermes gateway is alive, and the
// development DB has at least one NPC bound to a Hermes profile.
// The NPC name can be changed with DESKRPG_E2E_NPC.
const NPC = process.env.DESKRPG_E2E_NPC ?? "단비";

test.describe("NPC 1:1 conversation", () => {
  test("walk up by clicking and talk: reply arrives and is not printed twice", async ({ page }) => {
    await enterFirstChannel(page);
    // rAF throttling from a covered window shows up as the misleading failure "the character does not move".
    // Measure frames first so the failure is named on the spot.
    await waitForGameLoop(page);

    await openNpcDialog(page, NPC);

    // Ask for a deterministic answer — duplication must be decidable by comparing lengths.
    const reply = await sendAndAwaitReply(page, "다른 말 없이 딱 이 네 글자만 출력해: 사과딸기");

    expect(reply.length, "NPC 응답이 비어 있습니다").toBeGreaterThan(0);
    expect(
      isDoubled(reply),
      `응답이 정확히 두 번 반복되고 있습니다 — tool.progress 가 본문 스트림으로 샜습니다:\n${reply}`,
    ).toBe(false);
  });

  test("remembers the earlier conversation in the second message", async ({ page }) => {
    await enterFirstChannel(page);
    await openNpcDialog(page, NPC);

    // If the session does not carry over, the second turn cannot know this word.
    const token = `모카${Date.now() % 100000}`;
    await sendAndAwaitReply(page, `내 고양이 이름은 ${token} 이야. 한 문장으로 짧게 대답해.`);
    const recall = await sendAndAwaitReply(page, "내 고양이 이름이 뭐라고 했지? 이름만 말해줘.");

    expect(
      recall.replace(/\s+/g, ""),
      `앞 턴을 기억하지 못했습니다 — Hermes 세션이 이어지지 않았습니다. 받은 답: ${recall}`,
    ).toContain(token);
    expect(isDoubled(recall), `응답이 두 번 반복됩니다:\n${recall}`).toBe(false);
  });
});
