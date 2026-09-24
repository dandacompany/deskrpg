import assert from "node:assert/strict";
import test from "node:test";

import { OFFICE_ENVIRONMENTS, buildOfficeEnvironment } from "./office-environments";
import {
  commonAreaSeats,
  deskSeats,
  executiveSeats,
  furnitureSeats,
  isDeskSeatAnchor,
} from "./seating";
import { projectTiledGeometry, type TiledGeometryMap } from "@/lib/tiled-geometry";
import { deriveChannelMotionLayout } from "@/lib/channel-motion-layout";

// The CEO seat (the chair behind executive_desk) is not an assigned employee seat and is left out here.
const EXPECTED: Record<string, number> = {
  trading: 28,
  agency: 14,
  tech: 16,
  executive: 3,
  publishing: 13,
};
const EXECUTIVE: Record<string, number> = {
  trading: 0,
  agency: 1,
  tech: 0,
  executive: 1,
  publishing: 0,
};

for (const env of OFFICE_ENVIRONMENTS) {
  test(`${env.id}: 데스크 좌석은 공용 좌석과 대표석을 뺀 나머지다`, () => {
    const map = buildOfficeEnvironment(env.id);
    const objects = projectTiledGeometry(map as unknown as TiledGeometryMap).objects;
    const desk = deskSeats(objects);
    assert.equal(desk.length, EXPECTED[env.id]);
    assert.equal(executiveSeats(objects).length, EXECUTIVE[env.id]);
    assert.equal(
      desk.length,
      furnitureSeats(objects).length -
        commonAreaSeats(objects).length -
        executiveSeats(objects).length,
    );
    for (const seat of desk) {
      const col = Math.floor(seat.anchorX ?? seat.x);
      const row = Math.floor(seat.anchorZ ?? seat.z);
      assert.ok(isDeskSeatAnchor(objects, col, row));
    }
  });

  test(`${env.id}: 레이아웃의 deskSeatTiles 는 결정적이고 row→col 로 정렬된다`, () => {
    const map = buildOfficeEnvironment(env.id);
    const a = deriveChannelMotionLayout({ mapData: map }, [])!.deskSeatTiles;
    const b = deriveChannelMotionLayout(
      { mapData: buildOfficeEnvironment(env.id) },
      [],
    )!.deskSeatTiles;
    assert.deepEqual(a, b);
    assert.equal(a.length, EXPECTED[env.id]);
    const sorted = [...a].sort((x, y) => x.row - y.row || x.col - y.col);
    assert.deepEqual(a, sorted);
    assert.equal(new Set(a.map((t) => `${t.col},${t.row}`)).size, a.length);
  });
}
