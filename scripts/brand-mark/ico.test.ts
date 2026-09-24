import assert from "node:assert/strict";
import test from "node:test";

import { packIco } from "./ico";
import { simpleMarkSvg } from "./simple-mark";

test("ico is packed as header, directory, PNG in that order with correct offsets", () => {
  const first = Buffer.from("first-png");
  const second = Buffer.from("second-png-longer");
  const ico = packIco([
    { size: 16, png: first },
    { size: 32, png: second },
  ]);
  assert.equal(ico.readUInt16LE(2), 1, "아이콘 형식이 아니다");
  assert.equal(ico.readUInt16LE(4), 2, "항목 수가 다르다");
  assert.equal(ico.readUInt8(6), 16);
  assert.equal(ico.readUInt8(6 + 16), 32);
  const firstOffset = ico.readUInt32LE(6 + 12);
  assert.equal(ico.subarray(firstOffset, firstOffset + first.length).toString(), "first-png");
  const secondOffset = ico.readUInt32LE(6 + 16 + 12);
  assert.equal(secondOffset, firstOffset + first.length, "둘째 오프셋이 어긋났다");
  assert.equal(ico.length, secondOffset + second.length);
});

test("rejects an empty list and out-of-range sizes", () => {
  assert.throws(() => packIco([]), /ico_needs_entries/);
  assert.throws(() => packIco([{ size: 512, png: Buffer.from("x") }]), /ico_size_out_of_range/);
});

test("the simple mark is just a few shapes with no text", () => {
  const svg = simpleMarkSvg(32);
  assert.match(svg, /^<svg[^>]*width="32"/);
  assert.equal(/<text/.test(svg), false, "아이콘에 글자를 넣지 않는다");
  assert.ok(svg.match(/<rect/g)!.length <= 10, "도형이 너무 많다 — 16px 에서 뭉갠다");
});
