import assert from "node:assert/strict";
import test from "node:test";

import { getCenteredCameraBounds } from "./camera-layout";

test("adds symmetric padding when the map is smaller than the visible camera area", () => {
  assert.deepEqual(
    getCenteredCameraBounds({
      viewportWidth: 1200,
      viewportHeight: 800,
      zoom: 2,
      mapWidth: 400,
      mapHeight: 300,
    }),
    {
      x: -100,
      y: -50,
      width: 600,
      height: 400,
    },
  );
});

test("adds padding only on the smaller axis", () => {
  assert.deepEqual(
    getCenteredCameraBounds({
      viewportWidth: 1200,
      viewportHeight: 800,
      zoom: 2,
      mapWidth: 800,
      mapHeight: 300,
    }),
    {
      x: 0,
      y: -50,
      width: 800,
      height: 400,
    },
  );
});

test("keeps original bounds when the map is larger than the visible camera area", () => {
  assert.deepEqual(
    getCenteredCameraBounds({
      viewportWidth: 1200,
      viewportHeight: 800,
      zoom: 2,
      mapWidth: 900,
      mapHeight: 500,
    }),
    {
      x: 0,
      y: 0,
      width: 900,
      height: 500,
    },
  );
});
