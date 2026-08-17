import test from "node:test";
import assert from "node:assert/strict";

import { shouldShowPairingCard } from "./pairing-card-visibility";

test("shouldShowPairingCard", async (t) => {
  await t.test("상태가 아예 없으면 숨긴다 — 이게 원래 결함이었다", () => {
    // /gateways는 게이트웨이별 상태를 맵에 담아 두므로, 연결 테스트를 한 번도
    // 돌리지 않은 게이트웨이는 항목 자체가 없다. `state?.status !== "idle"` 로
    // 판단하던 시절에는 undefined !== "idle" 이 참이 되어 카드가 떠버렸다.
    assert.equal(shouldShowPairingCard(undefined), false);
    assert.equal(shouldShowPairingCard(null), false);
  });

  await t.test("idle이면 숨긴다", () => {
    assert.equal(shouldShowPairingCard({ status: "idle" }), false);
  });

  await t.test("보여줄 결과가 있으면 띄운다", () => {
    assert.equal(shouldShowPairingCard({ status: "connected" }), true);
    assert.equal(shouldShowPairingCard({ status: "error" }), true);
    assert.equal(shouldShowPairingCard({ status: "pairing-required" }), true);
    assert.equal(shouldShowPairingCard({ status: "pairing_required" }), true);
  });
});
