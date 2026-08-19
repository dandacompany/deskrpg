import test from "node:test";
import assert from "node:assert/strict";

import { partitionRegistrationResults, toDiscoveryRows, toProbeStatus } from "./discovery-rows";

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

test("partitionRegistrationResults", async (t) => {
  await t.test("성공한 이름은 selection에서 빠지고 실패 목록에 없다", () => {
    const { nextSelected, failures } = partitionRegistrationResults([
      { name: "sophie", ok: true },
    ]);
    assert.deepEqual(nextSelected, []);
    assert.deepEqual(failures, []);
  });

  await t.test("실패한 이름은 재시도를 위해 selection에 남고 사유가 붙는다", () => {
    const { nextSelected, failures } = partitionRegistrationResults([
      { name: "sophie", ok: true },
      { name: "danvi", ok: false, errorCode: "no_token" },
    ]);
    assert.deepEqual(nextSelected, ["danvi"]);
    assert.deepEqual(failures, [{ name: "danvi", errorCode: "no_token" }]);
  });

  await t.test("errorCode가 없는 실패는 register_failed로 접는다", () => {
    const { nextSelected, failures } = partitionRegistrationResults([
      { name: "ada", ok: false },
    ]);
    assert.deepEqual(nextSelected, ["ada"]);
    assert.deepEqual(failures, [{ name: "ada", errorCode: "register_failed" }]);
  });
});

test("toProbeStatus", async (t) => {
  await t.test("알려진 값은 그대로 통과한다", () => {
    assert.equal(toProbeStatus("ok"), "ok");
    assert.equal(toProbeStatus("not_found"), "not_found");
    assert.equal(toProbeStatus("unknown"), "unknown");
    assert.equal(toProbeStatus("idle"), "idle");
  });

  await t.test("모르는 문자열, undefined, null, 객체는 unknown으로 접는다", () => {
    assert.equal(toProbeStatus("valid"), "unknown");
    assert.equal(toProbeStatus(undefined), "unknown");
    assert.equal(toProbeStatus(null), "unknown");
    assert.equal(toProbeStatus({ status: "ok" }), "unknown");
  });
});
