import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import {
  enterFirstChannel,
  ensureTwoHermesNpcs,
  openNpcDialog,
  sendAndAwaitReply,
  isDoubled,
} from "./helpers";

// A meeting cannot be verified with one NPC — what we verify is "does the floor pass between
// participants". ensureTwoHermesNpcs prepares the second one.
//
// Preconditions are the same as npc-dm.spec.ts (see e2e/README.md). In a meeting several NPCs
// speak in turn, so it takes longer than 1:1.

/**
 * Enter the meeting room tab, pick participants and start the discussion.
 *
 * Selector note: the top button label carries a badge number ("회의실 0"). Matching the name
 * exactly stalls silently the moment the number changes — take a regex instead.
 */
async function startMeeting(page: Page, npcNames: string[], topic: string): Promise<void> {
  await page.getByRole("button", { name: /회의실/ }).click();

  // All participants are selected by default ("· 2/2 NPC"). Check it explicitly anyway —
  // if the default changes, it becomes "the meeting ran, but not with the NPCs we picked".
  await page.getByRole("button", { name: /진행 설정/ }).click();
  await page.getByText("참여 NPC").waitFor();
  for (const name of npcNames) {
    const box = page.locator("label").filter({ hasText: name }).locator('input[type="checkbox"]');
    if (!(await box.isChecked())) await box.check();
  }

  // Lower the turn cap to the minimum (5). At the default of 20 the meeting runs for minutes, and the moment the cap is hit
  // MeetingRoom replaces the message list with the result screen, so there is nothing left to collect.
  // What we verify is "does the floor pass", not the length of the meeting.
  await page.locator('input[type="range"]').first().fill("5");

  await page.getByPlaceholder("회의 주제를 입력하세요").fill(topic);
  await page.getByRole("button", { name: "회의 시작" }).click();
}

/**
 * Wait until targetCount NPC messages accumulate, then return a list of [speaker, content].
 *
 * When the meeting reaches the turn cap (default 20), MeetingRoom **replaces** the message list with the result screen
 * — and [data-meeting-message] vanishes entirely. Simply waiting with toHaveCount, if the meeting
 * ends first, watches 0 forever and times out (measured: an isolated scenario died after waiting
 * 5 minutes like this, while the meeting had actually run all 20 turns and left a summary).
 * So we poll instead of counting, and when the meeting ends we return what was collected up to that point.
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

    // When the meeting ends the message list disappears — waiting longer will not grow it.
    //
    // But a "종료" seen before any message was observed is **the previous meeting's result screen**.
    // Running scenarios back to back in the same channel leaves the earlier result in place, and
    // reading it as the end makes us give up after 8 seconds before the new meeting even takes its first turn (measured).
    if (best.length > 0) {
      const ended = await page
        .getByText("회의가 종료되었습니다")
        .isVisible()
        .catch(() => false);
      if (ended) break;
    }
    await page.waitForTimeout(1000);
  }

  expect(
    best.length,
    `NPC 발언을 ${targetCount}건 모으지 못했습니다(모은 것: ${best.length}건). ` +
      "회의가 턴을 돌리지 못했거나, 발언이 화면에 붙지 않았습니다.",
  ).toBeGreaterThanOrEqual(targetCount);
  return best;
}

/**
 * Wait until the meeting ends, then extract a fingerprint from the result screen text for the 1:1 contamination check.
 *
 * Why not count speech bubbles: when the meeting hits the turn cap MeetingRoom replaces the message list with the result
 * screen, so in a short meeting the observation window itself disappears (measured: a 5-turn meeting ended in 20 seconds
 * and polling never saw more than 0). The result screen's main topics and conclusions come from what was actually
 * said in the meeting, so they are enough as a fingerprint for the contamination check.
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

test.describe("meeting", () => {
  // With agent startup included, two NPCs taking one turn each takes much longer than 1:1.
  test.setTimeout(600_000);

  test("two NPCs take turns speaking — neither monopolizes", async ({ page }) => {
    await enterFirstChannel(page);
    const npcNames = await ensureTwoHermesNpcs(page);
    expect(npcNames.length, "회의에는 Hermes NPC 가 둘 필요합니다").toBeGreaterThanOrEqual(2);

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
      expect(isDoubled(text), `${who} 의 발언이 두 번 반복됩니다:\n${text}`).toBe(false);
    }
  });

  test("meeting text does not leak into the 1:1 dialog", async ({ page }) => {
    await enterFirstChannel(page);
    const npcNames = await ensureTwoHermesNpcs(page);
    const [first] = npcNames;

    // Run a meeting to build up multi-party context in the NPC sessions.
    await startMeeting(
      page,
      npcNames.slice(0, 2),
      "회의 격리 확인용 주제입니다. 한 문장으로 답하세요.",
    );
    // What this scenario checks is "is 1:1 uncontaminated after a meeting", not collecting
    // messages. A 5-turn meeting ends in 20 seconds, and the moment it ends the message list is
    // replaced wholesale by the result screen — trying to count messages misses that short window and sees nothing.
    // So we wait **until the meeting ends**, then take the actual content from the minutes.
    const turns = await waitForMeetingEnd(page);

    // The meeting already ended by hitting the turn cap — no need to stop it.
    //
    // (There used to be `getByRole("button", { name: /회의 종료|중단|정지/ }).click().catch(...)`
    //  here. No button with that name exists; stop is the ⏹ icon. .catch() only acts
    //  **after** the failure, so for each missing button it waited out the full 120s expect timeout
    //  and then moved on quietly — not a silent failure but a silent delay, and the two filled
    //  the 10-minute test timeout.)

    // Talk 1:1 with the same NPC. The engine owns the meeting transcript and 1:1 uses a separate
    // persistent session, so meeting messages showing up here means the sessions got mixed.
    // Reloading returns to office mode.
    await page.goto(page.url());
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
