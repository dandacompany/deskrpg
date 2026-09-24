import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";

import { authHeaders, seedChannelWithProfiles, setupThrowawaySqlite } from "@/test-setup/npc-seed";
import { buildOfficeEnvironment } from "@/game/three/office-environments";
import { commonAreaSeats } from "@/game/three/seating";
import { projectMeetingMap } from "@/game/meeting-map-normalization";
import { seatingMapFor } from "@/lib/seat-assignment";
import type { TiledMap } from "@/lib/tiled-map";

/**
 * Saving a channel map with no desk seats at all gives 400 — saved as is, seat assignment
 * would silently leave everyone standing, and the assigned-seat UI would see an empty roster.
 *
 * "Remove every chair" also removes the shared chairs by the meeting table and invalidates the map itself
 * (`normalizeMeetingMap` requires seats around the meeting table). Only personal desk
 * seats (`chair`s not attached to a shared table) are filtered — the same boundary that `deskSeats`/`commonAreaSeats`
 * (`src/game/three/seating.ts`) draw.
 */
setupThrowawaySqlite("channel-map-seat-guard-test");

function stripDeskChairs(map: TiledMap): TiledMap {
  // `projectMeetingMap` projects Tiled objects from pixel to tile (col/row) coordinates. The original
  // Tiled objects only have `x`/`y` pixels, so whether they share a tile with a common seat can only be compared
  // in those projected coordinates.
  const projected = projectMeetingMap(map);
  const keep = new Set(
    commonAreaSeats(projected.objects).map(
      (seat) => `${Math.floor(seat.anchorX ?? seat.x)},${Math.floor(seat.anchorZ ?? seat.z)}`,
    ),
  );
  return {
    ...map,
    layers: map.layers.map((layer) =>
      layer.type === "objectgroup"
        ? {
            ...layer,
            objects: (layer.objects ?? []).filter(
              (object) => object.type !== "chair" || keep.has(`${object.x / 32},${object.y / 32}`),
            ),
          }
        : layer,
    ),
  };
}

test("the chairless fixture has 0 seats — if this assertion breaks, the tests below are meaningless", () => {
  const stripped = stripDeskChairs(buildOfficeEnvironment("executive"));
  assert.equal(seatingMapFor({ mapData: stripped })!.seats.length, 0);
});

test("a map with no desk chairs is 400 map_has_no_desk_seats", async () => {
  const { channelId, userId } = await seedChannelWithProfiles({
    mapData: buildOfficeEnvironment("executive"),
  });
  const { PUT } = await import("./route");
  const stripped = stripDeskChairs(buildOfficeEnvironment("executive"));

  const res = await PUT(
    new NextRequest(`http://localhost/api/channels/${channelId}`, {
      method: "PUT",
      headers: { ...authHeaders(userId), "content-type": "application/json" },
      body: JSON.stringify({ mapData: stripped }),
    }),
    { params: Promise.resolve({ id: channelId }) },
  );

  assert.equal(res.status, 400);
  assert.equal((await res.json()).errorCode, "map_has_no_desk_seats");
});

test("the original map (with chairs) is saved as is", async () => {
  const { channelId, userId } = await seedChannelWithProfiles({
    mapData: buildOfficeEnvironment("executive"),
  });
  const { PUT } = await import("./route");

  const res = await PUT(
    new NextRequest(`http://localhost/api/channels/${channelId}`, {
      method: "PUT",
      headers: { ...authHeaders(userId), "content-type": "application/json" },
      body: JSON.stringify({ mapData: buildOfficeEnvironment("executive") }),
    }),
    { params: Promise.resolve({ id: channelId }) },
  );

  assert.equal(res.status, 200);
});
