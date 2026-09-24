import { test } from "node:test";
import assert from "node:assert/strict";

import { parseOpenGraph } from "./parse";

test("extracts title, description, and image from og tags", () => {
  const html = `<html><head>
    <meta property="og:title" content="제목입니다">
    <meta property="og:description" content="설명입니다">
    <meta property="og:image" content="https://cdn.example.com/a.png">
    <meta property="og:site_name" content="예시">
  </head><body>본문</body></html>`;
  assert.deepEqual(parseOpenGraph(html, new URL("https://example.com/p")), {
    title: "제목입니다",
    description: "설명입니다",
    image: "https://cdn.example.com/a.png",
    siteName: "예시",
  });
});

test("falls back to <title> and meta description when there's no og", () => {
  const html = `<head><title>보통 제목</title>
    <meta name="description" content="보통 설명"></head>`;
  const got = parseOpenGraph(html, new URL("https://example.com/p"));
  assert.equal(got?.title, "보통 제목");
  assert.equal(got?.description, "보통 설명");
  assert.equal(got?.image, null);
  assert.equal(got?.siteName, "example.com");
});

test("a relative-path image is resolved to absolute against the document URL", () => {
  const html = `<meta property="og:image" content="/img/a.png"><title>t</title>`;
  const got = parseOpenGraph(html, new URL("https://example.com/dir/p"));
  assert.equal(got?.image, "https://example.com/img/a.png");
});

test("drops a non-http(s) image", () => {
  const html = `<meta property="og:image" content="data:image/png;base64,AAA"><title>t</title>`;
  assert.equal(parseOpenGraph(html, new URL("https://example.com/p"))?.image, null);
});

test("reads it even with attribute order reversed (content first)", () => {
  const html = `<meta content="뒤집힘" property="og:title">`;
  assert.equal(parseOpenGraph(html, new URL("https://example.com/p"))?.title, "뒤집힘");
});

test("decodes HTML entities and truncates length", () => {
  const html = `<meta property="og:title" content="A &amp; B &quot;C&quot;">
    <meta property="og:description" content="${"가".repeat(400)}">`;
  const got = parseOpenGraph(html, new URL("https://example.com/p"));
  assert.equal(got?.title, 'A & B "C"');
  assert.equal(got?.description?.length, 300);
});

test("with no title and no image, there's nothing to build a card from — null", () => {
  assert.equal(parseOpenGraph("<html><body>본문만</body></html>", new URL("https://e.com/")), null);
});
