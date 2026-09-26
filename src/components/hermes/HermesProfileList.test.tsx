import assert from "node:assert/strict";
import test from "node:test";

import { cleanup, mockFetch, render, text } from "../skills/skills-test-harness";
import HermesProfileList from "./HermesProfileList";

const GW = "gw-1";
const routes = {
  [`GET /api/gateways/${GW}/profiles`]: {
    profiles: [
      { id: "p-1", profileName: "sophie", displayName: "소피", lastValidationStatus: null },
    ],
  },
  [`GET /api/gateways/${GW}/local-discovery`]: { available: false },
};

test.afterEach(cleanup);

test("a gateway shared with you shows its employees but no way to add one", async () => {
  mockFetch(routes);
  await render(<HermesProfileList gatewayId={GW} canRegister={false} />);
  assert.match(text(), /소피/);
  assert.doesNotMatch(text(), /새 직원 고용/);
  assert.doesNotMatch(text(), /이미 있는 프로필 등록/);
});

test("the gateway owner sees the hire link and the register form", async () => {
  mockFetch(routes);
  await render(<HermesProfileList gatewayId={GW} canRegister />);
  assert.match(text(), /새 직원 고용/);
  assert.match(text(), /이미 있는 프로필 등록/);
});
