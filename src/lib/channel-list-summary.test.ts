import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildOfficeEnvironment, OFFICE_ENVIRONMENTS } from "../game/three/office-environments";
import agencyV2 from "./fixtures/official-agency-v2.json";
import { detectOfficeEnvironmentId, summarizeParticipants } from "./channel-list-summary";

describe("detectOfficeEnvironmentId", () => {
  it("a channel map built from an official environment is recognized as that environment", () => {
    for (const environment of OFFICE_ENVIRONMENTS) {
      assert.equal(
        detectOfficeEnvironmentId(buildOfficeEnvironment(environment.id)),
        environment.id,
      );
    }
  });

  it("recognizes a map the DB returned as a string too (SQLite)", () => {
    assert.equal(detectOfficeEnvironmentId(JSON.stringify(buildOfficeEnvironment("tech"))), "tech");
  });

  it("still the same environment when objects change but the floor and size match", () => {
    const map = structuredClone(buildOfficeEnvironment("executive")) as {
      layers: Array<{ name: string; objects?: unknown[] }>;
    };
    const objects = map.layers.find((layer) => layer.name === "Objects");
    objects?.objects?.pop();
    assert.equal(detectOfficeEnvironmentId(map), "executive");
  });

  it("an old official map from before the upgrade is recognized as its upgrade-target environment", () => {
    assert.equal(detectOfficeEnvironmentId(agencyV2), "agency");
  });

  it("an unknown map, empty value, or broken JSON is null", () => {
    assert.equal(detectOfficeEnvironmentId(null), null);
    assert.equal(detectOfficeEnvironmentId("{not json"), null);
    assert.equal(detectOfficeEnvironmentId({ width: 3, height: 3, layers: [] }), null);
  });
});

describe("summarizeParticipants", () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 8, 19, 0, minute));

  it("owner first, the rest in join order, only the first five", () => {
    const rows = [
      { userId: "u3", nickname: "셋", appearance: { a: 3 }, joinedAt: at(3) },
      { userId: "u1", nickname: "하나", appearance: { a: 1 }, joinedAt: at(1) },
      { userId: "owner", nickname: "주인", appearance: { a: 0 }, joinedAt: at(9) },
      { userId: "u2", nickname: "둘", appearance: null, joinedAt: at(2) },
      { userId: "u4", nickname: "넷", appearance: null, joinedAt: at(4) },
      { userId: "u5", nickname: "다섯", appearance: null, joinedAt: at(5) },
    ];
    const summary = summarizeParticipants(rows, "owner");
    assert.equal(summary.count, 6);
    assert.deepEqual(
      summary.preview.map((p) => p.nickname),
      ["주인", "하나", "둘", "셋", "넷"],
    );
    assert.deepEqual(summary.preview[0], { nickname: "주인", appearance: { a: 0 } });
  });

  it("the same user appearing twice still counts as one", () => {
    const rows = [
      { userId: "owner", nickname: "주인", appearance: null, joinedAt: at(0) },
      { userId: "owner", nickname: "주인", appearance: null, joinedAt: null },
    ];
    assert.equal(summarizeParticipants(rows, "owner").count, 1);
  });

  it("is 0 when there is nobody", () => {
    assert.deepEqual(summarizeParticipants([], "owner"), { count: 0, preview: [] });
  });
});
