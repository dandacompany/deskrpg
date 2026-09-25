import assert from "node:assert/strict";
import test from "node:test";

import { $, cleanup, click, container, render, text } from "../skills/skills-test-harness";
import { MeetingControlBar } from "../MeetingRoom";

const t = (key: string) => key;

function bar(stopping: boolean, onStop: () => void) {
  return (
    <MeetingControlBar
      mode="manual"
      isWaiting
      stopping={stopping}
      currentSpeaker={null}
      npcs={[]}
      lastSpokeTimes={{}}
      nowMs={0}
      onSetMode={() => {}}
      onNextTurn={() => {}}
      onDirectSpeak={() => {}}
      onStop={onStop}
      t={t}
    />
  );
}

test.afterEach(cleanup);

test("while stopping, the stop and next-turn buttons are locked and the bar says so", async () => {
  let stops = 0;
  await render(bar(true, () => stops++));
  assert.equal(($("[data-meeting-stop]") as HTMLButtonElement).disabled, true);
  assert.equal(($("[title='meeting.nextTurnBtn']") as HTMLButtonElement).disabled, true);
  assert.match($("[data-meeting-stopping]").textContent ?? "", /meeting\.stopping/);
  assert.doesNotMatch(text(), /meeting\.nextTurn(?!Btn)/);
  await click("[data-meeting-stop]");
  assert.equal(stops, 0);
});

test("before stopping, the stop button works and no stopping label shows", async () => {
  let stops = 0;
  await render(bar(false, () => stops++));
  assert.equal(container.querySelector("[data-meeting-stopping]"), null);
  await click("[data-meeting-stop]");
  assert.equal(stops, 1);
});
