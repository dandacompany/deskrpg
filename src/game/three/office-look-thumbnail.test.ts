import test from "node:test";
import assert from "node:assert/strict";
import { PORTRAIT_FRAMING } from "./office-look-thumbnail";

/**
 * The round avatar portrait must include from the top of the head (including high buns and curls, ~1.9m) down to both
 * shoulders (~1.45m). Real rendering needs WebGL and cannot run in node tests, so instead the geometry pins that
 * these framing constants cover that vertical span. The actual on-screen check was done separately with the contact sheet
 * in art/portrait-check/ (all 50 looks).
 */
test("the portrait framing is square and vertically covers the span from shoulders to the top of the head", () => {
  const { fov, position, target } = PORTRAIT_FRAMING;

  // The output must be square (paired with the premise that the camera is created with aspect 1).
  assert.equal(typeof fov, "number");
  assert.ok(fov > 0 && fov < 60, "얼굴이 늘어나지 않도록 표준 인물 화각을 쓴다");

  // The target height must be between the shoulders and the top of the head.
  assert.ok(target.y >= 1.5 && target.y <= 1.75, `target.y=${target.y} 가 범위를 벗어났다`);

  const distance = position.distanceTo(target);
  const verticalSpanMeters = 2 * distance * Math.tan((fov * Math.PI) / 180 / 2);
  assert.ok(
    verticalSpanMeters >= 0.5 && verticalSpanMeters <= 0.75,
    `verticalSpanMeters=${verticalSpanMeters} 가 0.5~0.75m 범위를 벗어났다`,
  );

  const top = target.y + verticalSpanMeters / 2;
  const bottom = target.y - verticalSpanMeters / 2;
  assert.ok(top >= 1.9, `head top 1.9m 이 프레임 위쪽(${top}) 안에 들어와야 한다`);
  assert.ok(bottom <= 1.45, `shoulders ~1.45m 이 프레임 아래쪽(${bottom}) 안에 들어와야 한다`);

  // The camera must be slightly off-front (a small +X offset) — dead center front looks flat.
  assert.ok(position.x > 0 && position.x < 0.6, `position.x=${position.x}`);
});
