import { test } from "node:test";
import assert from "node:assert/strict";

import { chatUrlTransform } from "./markdown-url";

const img = { tagName: "img" };
const anchor = { tagName: "a" };

test("a normal address keeps the default behavior", () => {
  assert.equal(chatUrlTransform("https://example.com/a", "src", img), "https://example.com/a");
  assert.equal(chatUrlTransform("/api/x", "href", anchor), "/api/x");
  // A dangerous scheme is still stripped.
  assert.equal(chatUrlTransform("javascript:alert(1)", "href", anchor), "");
});

test("a raster data: URL in an image is let through — removing it would just leave a broken icon", () => {
  const src = "data:image/png;base64,AAAA";
  assert.equal(chatUrlTransform(src, "src", img), src);
  assert.equal(
    chatUrlTransform("data:image/webp;base64,AAAA", "src", img),
    "data:image/webp;base64,AAAA",
  );
});

test("svg and non-image data: URLs are stripped — svg is a document that can carry a script", () => {
  assert.equal(chatUrlTransform("data:image/svg+xml;base64,AAAA", "src", img), "");
  assert.equal(chatUrlTransform("data:text/html;base64,AAAA", "src", img), "");
});

test("a data: URL in a link is never let through — only allowed in an image slot", () => {
  assert.equal(chatUrlTransform("data:image/png;base64,AAAA", "href", anchor), "");
});
