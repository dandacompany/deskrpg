import assert from "node:assert/strict";
import test from "node:test";

import {
  SAMPLE_PROJECT_NAME,
  buildStarterProjectValues,
  shouldCreateStarterProject,
} from "./builtin-projects";

test("starter project is only created for users without existing projects", () => {
  assert.equal(shouldCreateStarterProject(0), true);
  assert.equal(shouldCreateStarterProject(1), false);
  assert.equal(shouldCreateStarterProject(5), false);
});

test("starter project values are built with the sample name and user ownership", () => {
  const values = buildStarterProjectValues({
    userId: "user-1",
    snapshot: {
      thumbnail: "data:image/png;base64,abc",
      settings: { cols: 20, rows: 15, tileWidth: 32, tileHeight: 32 },
      tiledJson: { width: 20, height: 15, tilesets: [] },
    },
  });

  assert.equal(values.name, SAMPLE_PROJECT_NAME);
  assert.equal(values.createdBy, "user-1");
  assert.equal(values.thumbnail, "data:image/png;base64,abc");
  assert.deepEqual(values.settings, { cols: 20, rows: 15, tileWidth: 32, tileHeight: 32 });
  assert.deepEqual(values.tiledJson, { width: 20, height: 15, tilesets: [] });
});
