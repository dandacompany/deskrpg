import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { FloorInbox } from "./inbox";

const always = () => true;
const noop = () => {};

/** take 를 큐가 빌 때까지 반복해 발언 순서를 배열로 뽑는다. */
function drainAll(
  inbox: FloorInbox,
  isEligible: (npcId: string) => boolean = always,
  onSkipped: (npcId: string) => void = noop,
): string[] {
  const out: string[] = [];
  for (;;) {
    const next = inbox.take(isEligible, onSkipped);
    if (next === null) return out;
    out.push(next);
  }
}

describe("FloorInbox", () => {
  test("빈 인박스는 null 을 돌려준다", () => {
    assert.equal(new FloorInbox().take(always, noop), null);
  });

  test("멘션은 들어온 순서대로 전부 나온다 — 하나도 버려지지 않는다", () => {
    const inbox = new FloorInbox();
    inbox.push("b", "mention");
    inbox.push("c", "mention");
    inbox.push("d", "mention");
    assert.deepEqual(drainAll(inbox), ["b", "c", "d"]);
  });

  test("사용자 지목은 대기 중인 멘션 앞에 서고, 멘션은 그대로 남는다", () => {
    const inbox = new FloorInbox();
    inbox.push("b", "mention");
    inbox.push("c", "mention");
    inbox.push("d", "user");
    assert.deepEqual(drainAll(inbox), ["d", "b", "c"]);
  });

  test("사용자 지목이 둘이면 마지막 것만 남는다", () => {
    const inbox = new FloorInbox();
    inbox.push("a", "user");
    inbox.push("b", "user");
    assert.deepEqual(drainAll(inbox), ["b"]);
  });

  test("같은 NPC 를 두 번 멘션하면 한 번만 나오고, 순서는 처음 위치를 지킨다", () => {
    const inbox = new FloorInbox();
    inbox.push("b", "mention");
    inbox.push("c", "mention");
    inbox.push("b", "mention");
    assert.deepEqual(drainAll(inbox), ["b", "c"]);
  });

  test("사용자 지목은 같은 NPC 의 대기 중 멘션을 흡수한다 — 두 번 말하지 않는다", () => {
    const inbox = new FloorInbox();
    inbox.push("b", "mention");
    inbox.push("c", "mention");
    inbox.push("b", "user");
    assert.deepEqual(drainAll(inbox), ["b", "c"]);
  });

  test("자격 없는 멘션은 건너뛰고 onSkipped 로 알린다", () => {
    const inbox = new FloorInbox();
    inbox.push("b", "mention");
    inbox.push("c", "mention");
    const skipped: string[] = [];
    const order = drainAll(inbox, (npcId) => npcId !== "b", (npcId) => skipped.push(npcId));
    assert.deepEqual(order, ["c"]);
    assert.deepEqual(skipped, ["b"], "건너뛴 지목은 무음으로 사라지면 안 된다");
  });

  test("사용자 지목은 자격 검사를 받지 않는다 — 쿼터를 우회한다", () => {
    const inbox = new FloorInbox();
    inbox.push("b", "user");
    const skipped: string[] = [];
    const order = drainAll(inbox, () => false, (npcId) => skipped.push(npcId));
    assert.deepEqual(order, ["b"]);
    assert.deepEqual(skipped, []);
  });

  test("pendingCount 는 대기 중인 부여 수를 센다", () => {
    const inbox = new FloorInbox();
    assert.equal(inbox.pendingCount(), 0);
    inbox.push("b", "mention");
    inbox.push("c", "mention");
    inbox.push("d", "user");
    assert.equal(inbox.pendingCount(), 3);
    inbox.take(always, noop);
    assert.equal(inbox.pendingCount(), 2);
  });

  test("clear 는 전부 비운다", () => {
    const inbox = new FloorInbox();
    inbox.push("b", "mention");
    inbox.push("d", "user");
    inbox.clear();
    assert.equal(inbox.pendingCount(), 0);
    assert.equal(inbox.take(always, noop), null);
  });
});
