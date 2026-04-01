import assert from "node:assert/strict";
import test from "node:test";

import { getProjectMapDataForLoad } from "./project-load";

test("project load preserves embedded tilesets when there are no linked DB tilesets", () => {
  const mapData = getProjectMapDataForLoad(
    {
      width: 20,
      height: 15,
      tilewidth: 32,
      tileheight: 32,
      orientation: "orthogonal",
      renderorder: "right-down",
      layers: [],
      tilesets: [{ firstgid: 1, name: "embedded", tilewidth: 32, tileheight: 32, tilecount: 1, columns: 1, image: "data:image/png;base64,abc", imagewidth: 32, imageheight: 32 }],
      nextlayerid: 1,
      nextobjectid: 1,
      infinite: false,
      type: "map",
      version: "1.10",
      tiledversion: "1.11.0",
      compressionlevel: -1,
    },
    [],
  );

  assert.equal(mapData.tilesets.length, 1);
  assert.equal(mapData.tilesets[0]?.name, "embedded");
});

test("project load clears embedded tilesets when linked DB tilesets are present", () => {
  const mapData = getProjectMapDataForLoad(
    {
      width: 20,
      height: 15,
      tilewidth: 32,
      tileheight: 32,
      orientation: "orthogonal",
      renderorder: "right-down",
      layers: [],
      tilesets: [{ firstgid: 1, name: "embedded", tilewidth: 32, tileheight: 32, tilecount: 1, columns: 1, image: "data:image/png;base64,abc", imagewidth: 32, imageheight: 32 }],
      nextlayerid: 1,
      nextobjectid: 1,
      infinite: false,
      type: "map",
      version: "1.10",
      tiledversion: "1.11.0",
      compressionlevel: -1,
    },
    [{ id: "ts-1" }],
  );

  assert.equal(mapData.tilesets.length, 0);
});
