import assert from "node:assert/strict";
import test from "node:test";
import { OFFICE_ENVIRONMENTS, buildOfficeEnvironment } from "@/game/three/office-environments";
import { deskSeatLabels } from "@/game/three/seating";
import { normalizeMeetingMap, projectMeetingMap } from "@/game/meeting-map-normalization";
import { deriveChannelMotionLayout } from "@/lib/channel-motion-layout";
import { seatingMapFor } from "@/lib/seat-assignment";

for (const env of OFFICE_ENVIRONMENTS) {
  test(`${env.id}: 화면 라벨 번호는 서버 좌석 번호와 같다`, () => {
    const mapData = buildOfficeEnvironment(env.id);
    const layout = deriveChannelMotionLayout({ mapData }, [])!;
    const objects = projectMeetingMap(normalizeMeetingMap(mapData, null).mapData).objects;
    const labels = deskSeatLabels(objects, layout.isWalkable, () => false);
    assert.ok(labels.length > 0);
    assert.deepEqual(
      labels.map(({ col, row, number }) => ({ col, row, number })),
      seatingMapFor({ mapData })!.seats,
    );
  });
}

test("marks as taken only the tiles for which the taken callback is true", () => {
  const mapData = buildOfficeEnvironment(OFFICE_ENVIRONMENTS[0].id);
  const layout = deriveChannelMotionLayout({ mapData }, [])!;
  const objects = projectMeetingMap(normalizeMeetingMap(mapData, null).mapData).objects;
  const [first] = deskSeatLabels(objects, layout.isWalkable, () => false);
  const labels = deskSeatLabels(
    objects,
    layout.isWalkable,
    (col, row) => col === first.col && row === first.row,
  );
  assert.deepEqual(
    labels.filter((l) => l.taken).map((l) => l.number),
    [first.number],
  );
});
