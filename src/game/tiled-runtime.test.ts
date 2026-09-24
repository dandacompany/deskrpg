import test from "node:test";
import assert from "node:assert/strict";
import { buildOfficeEnvironment, OFFICE_ENVIRONMENTS } from "./three/office-environments";
import { withRuntimeTileset } from "./tiled-runtime";

test("positive tile GIDs of every official map exist in the runtime tileset", () => {
  for (const { id } of OFFICE_ENVIRONMENTS) {
    const source = buildOfficeEnvironment(id);
    const before = JSON.stringify(source);
    const runtime = withRuntimeTileset(source as unknown as Record<string, unknown>);
    const sets = runtime.tilesets as { firstgid: number; tilecount: number }[];
    for (const layer of source.layers)
      for (const gid of layer.data ?? []) {
        if (gid > 0)
          assert.ok(
            sets.some((s) => gid >= s.firstgid && gid < s.firstgid + s.tilecount),
            `${id}: ${gid}`,
          );
      }
    assert.equal(JSON.stringify(source), before);
    assert.equal(runtime.layers, source.layers);
  }
});
test("user tilesets are not replaced", () => {
  const map = { tilesets: [{ firstgid: 1, source: "custom.tsx" }] };
  assert.equal(withRuntimeTileset(map), map);
});
