import assert from "node:assert/strict";
import test from "node:test";

import { getAvatarFrameRect } from "./avatar-frame";

test("directional avatar frame picks the matching LPC row", () => {
  assert.deepEqual(getAvatarFrameRect("front"), { sx: 0, sy: 128, sw: 64, sh: 64 });
  assert.deepEqual(getAvatarFrameRect("back"), { sx: 0, sy: 0, sw: 64, sh: 64 });
});
