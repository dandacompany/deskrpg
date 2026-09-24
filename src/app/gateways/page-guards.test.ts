import assert from "node:assert/strict";
import test from "node:test";

import { planGatewayDelete } from "@/app/gateways/gateway-delete-plan";
import { backLinkTarget } from "@/app/gateways/return-target";

/**
 * `?returnTo=` is a user-supplied value. If the gateway screen put it into a link as is,
 * a single `//evil.com` would make an open redirect. Rendering page.tsx whole would require
 * mimicking the next/navigation router, so that one line is pulled out as `backLinkTarget` and
 * pinned here — page.tsx calls only this function.
 */
test("the back link does not let a hostile returnTo through", () => {
  assert.equal(backLinkTarget("//evil.com"), "/channels");
  assert.equal(backLinkTarget("/\\evil.com"), "/channels");
  assert.equal(backLinkTarget("https://evil.com/x"), "/channels");
  assert.equal(backLinkTarget("/channels/abc"), "/channels/abc");
  assert.equal(backLinkTarget(null), null, "돌아갈 곳이 없으면 링크를 띄우지 않는다");
});

/**
 * Deleting a gateway is refused by the server with 409 if there is even one channel binding
 * (`api/gateways/[id]/route.ts:126-138`). Still asking "함께 사라집니다" makes the
 * user agree to a deletion that will not happen and see a screen where nothing happened.
 *
 * Rendering page.tsx whole would require mimicking the app router context (useSearchParams/useRouter),
 * so that branch is pulled out as `planGatewayDelete` and pinned here —
 * `handleDelete` looks only at this verdict and skips the confirmation and DELETE.
 */
test("when out in channels, the delete confirmation is not shown at all", () => {
  const plan = planGatewayDelete({ profiles: 1, npcs: 2, channels: 2 });
  assert.equal(
    plan.blocked,
    true,
    "채널에 묶인 게이트웨이인데 확인을 띄운다 — 서버는 409 로 거절하므로 거짓 확인이 된다",
  );
});

test("when nobody is in any channel, the confirmation includes profile and NPC counts", () => {
  const plan = planGatewayDelete({ profiles: 1, npcs: 3, channels: 0 });
  assert.equal(plan.blocked, false);
  assert.equal(plan.blocked === false && plan.npcs, 3);
});
