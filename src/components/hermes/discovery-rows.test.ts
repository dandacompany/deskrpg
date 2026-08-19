import test from "node:test";
import assert from "node:assert/strict";

import { toDiscoveryRows } from "./discovery-rows";

test("toDiscoveryRows", async (t) => {
  await t.test("토큰이 있고 서빙 중이며 미등록이면 선택 가능", () => {
    const [row] = toDiscoveryRows([
      { name: "sophie", hasToken: true, servedByGateway: true, alreadyRegistered: false },
    ]);
    assert.deepEqual(row, {
      name: "sophie",
      hasToken: true,
      servedByGateway: true,
      alreadyRegistered: false,
      selectable: true,
      reason: "ok",
    });
  });

  await t.test("이미 등록됐으면 선택 불가 — 사유가 우선한다", () => {
    const [row] = toDiscoveryRows([
      { name: "danvi", hasToken: true, servedByGateway: true, alreadyRegistered: true },
    ]);
    assert.equal(row.selectable, false);
    assert.equal(row.reason, "already");
  });

  await t.test("토큰이 없으면 선택 불가", () => {
    const [row] = toDiscoveryRows([
      { name: "ada", hasToken: false, servedByGateway: true, alreadyRegistered: false },
    ]);
    assert.equal(row.selectable, false);
    assert.equal(row.reason, "no_token");
  });

  await t.test("게이트웨이가 서빙하지 않으면 선택 불가", () => {
    // acestep_output 처럼 프로필 모양이지만 에이전트가 아닌 디렉토리가 여기 걸린다.
    const [row] = toDiscoveryRows([
      { name: "acestep_output", hasToken: true, servedByGateway: false, alreadyRegistered: false },
    ]);
    assert.equal(row.selectable, false);
    assert.equal(row.reason, "not_served");
  });
});
