import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { GET } from "./route";

test("the public social image comes down as a 1200×630 PNG", async () => {
  const response = await GET();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^image\/png/);

  const image = await sharp(Buffer.from(await response.arrayBuffer())).metadata();
  assert.equal(image.width, 1200);
  assert.equal(image.height, 630);
  assert.equal(image.format, "png");
});
