import { test, expect } from "@playwright/test";
import {
  enterFirstChannel,
  openNpcDialog,
  sendAndAwaitReply,
  isDoubled,
  waitForGameLoop,
} from "./helpers";

// 실행 전제: `npm run dev` 가 떠 있고, 로컬 Hermes 게이트웨이가 살아 있으며,
// 개발 DB 에 Hermes 프로필이 묶인 NPC 가 최소 하나 있어야 한다.
// NPC 이름은 DESKRPG_E2E_NPC 로 바꿀 수 있다.
const NPC = process.env.DESKRPG_E2E_NPC ?? "단비";

test.describe("NPC 1:1 대화", () => {
  test("클릭으로 다가가 말을 걸면 답이 오고, 그 답은 두 번 찍히지 않는다", async ({ page }) => {
    await enterFirstChannel(page);
    // 창 가림으로 인한 rAF 스로틀은 "캐릭터가 안 움직인다"는 엉뚱한 실패로 나타난다.
    // 실패 원인을 그 자리에서 이름 붙이기 위해 먼저 프레임을 잰다.
    await waitForGameLoop(page);

    await openNpcDialog(page, NPC);

    // 결정적인 답을 요구한다 — 길이 비교로 중복을 판정할 수 있어야 한다.
    const reply = await sendAndAwaitReply(page, "다른 말 없이 딱 이 네 글자만 출력해: 사과딸기");

    expect(reply.length, "NPC 응답이 비어 있습니다").toBeGreaterThan(0);
    expect(
      isDoubled(reply),
      `응답이 정확히 두 번 반복되고 있습니다 — tool.progress 가 본문 스트림으로 샜습니다:\n${reply}`,
    ).toBe(false);
  });

  test("두 번째 메시지에서 앞 대화를 기억한다", async ({ page }) => {
    await enterFirstChannel(page);
    await openNpcDialog(page, NPC);

    // 세션이 이어지지 않으면 두 번째 턴에서 이 단어를 알 수 없다.
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
