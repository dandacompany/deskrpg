import test from "node:test";
import assert from "node:assert/strict";

import { discoverLocalProfiles } from "./local-discovery";

const BASE = "http://127.0.0.1:8642";

test("discoverLocalProfiles", async (t) => {
  await t.test("파일시스템과 게이트웨이를 겹쳐 판단한다", async () => {
    // acestep_output 은 실측상 프로필과 같은 레이아웃이지만 게이트웨이가 서빙하지
    // 않는다. 파일시스템만 믿으면 이걸 프로필로 제시하게 된다.
    const result = await discoverLocalProfiles({
      baseUrl: BASE,
      localProfiles: [
        { name: "sophie", hasToken: true },
        { name: "acestep_output", hasToken: true },
      ],
      registeredNames: [],
      probe: async (_base, profile) =>
        profile === "sophie" ? "hermes" : "not-hermes",
    });
    assert.deepEqual(result, [
      {
        name: "sophie",
        hasToken: true,
        servedByGateway: true,
        alreadyRegistered: false,
      },
      {
        name: "acestep_output",
        hasToken: true,
        servedByGateway: false,
        alreadyRegistered: false,
      },
    ]);
  });

  await t.test("이미 등록된 이름을 표시한다", async () => {
    const result = await discoverLocalProfiles({
      baseUrl: BASE,
      localProfiles: [{ name: "danvi", hasToken: true }],
      registeredNames: ["danvi"],
      probe: async () => "hermes",
    });
    assert.equal(result[0].alreadyRegistered, true);
  });

  await t.test(
    "탐침이 실패해도 목록은 돌려준다 — servedByGateway=false",
    async () => {
      const result = await discoverLocalProfiles({
        baseUrl: BASE,
        localProfiles: [{ name: "sophie", hasToken: true }],
        registeredNames: [],
        probe: async () => "unreachable",
      });
      assert.deepEqual(result, [
        {
          name: "sophie",
          hasToken: true,
          servedByGateway: false,
          alreadyRegistered: false,
        },
      ]);
    },
  );

  await t.test("반환값에 토큰이 절대 실리지 않는다", async () => {
    const result = await discoverLocalProfiles({
      baseUrl: BASE,
      localProfiles: [{ name: "sophie", hasToken: true }],
      registeredNames: [],
      probe: async () => "hermes",
    });
    assert.equal(JSON.stringify(result).includes("API_SERVER_KEY"), false);
    assert.deepEqual(Object.keys(result[0]).sort(), [
      "alreadyRegistered",
      "hasToken",
      "name",
      "servedByGateway",
    ]);
  });
});
