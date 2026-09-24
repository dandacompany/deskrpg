import { test } from "node:test";
import assert from "node:assert/strict";

import { chatFileLink } from "./chat-file-link";

test("an artifact content link is treated as a file and gets download=1 appended", () => {
  const link = chatFileLink("/api/channels/c1/artifacts/a1/versions/3/content");
  assert.deepEqual(link, {
    href: "/api/channels/c1/artifacts/a1/versions/3/content?download=1",
    filename: undefined,
  });
});

test("if download=1 is already appended, it's not appended twice", () => {
  const link = chatFileLink("/api/channels/c1/artifacts/a1/versions/3/content?download=1");
  assert.equal(link?.href, "/api/channels/c1/artifacts/a1/versions/3/content?download=1");
});

test("a card attachment link is a file", () => {
  assert.ok(chatFileLink("/api/channels/c1/kanban/attachments/f1"));
});

test("an external link with a document/data/archive extension is also treated as a file", () => {
  assert.equal(
    chatFileLink("https://example.com/files/보고서.xlsx")?.filename,
    "보고서.xlsx",
    "다운로드 이름은 마지막 경로 조각에서 가져온다",
  );
  assert.ok(chatFileLink("https://example.com/a/b.pdf"));
  assert.ok(chatFileLink("https://example.com/a/b.zip?v=2"));
  assert.ok(chatFileLink("https://example.com/a/b.md"));
});

test("an ordinary web page link is not a file — an icon on every link would just be noise", () => {
  assert.equal(chatFileLink("https://example.com/blog/post"), null);
  assert.equal(chatFileLink("https://example.com/"), null);
  assert.equal(chatFileLink("https://example.com/index.html"), null);
});

test("not http(s) means not a file", () => {
  assert.equal(chatFileLink("javascript:alert(1)"), null);
  assert.equal(chatFileLink("data:text/csv;base64,AAAA"), null);
  assert.equal(chatFileLink(undefined), null);
});

test("an inline base64 image can also be downloaded — a picture an employee made is a file", () => {
  const link = chatFileLink("data:image/png;base64,AAAA");
  assert.equal(link?.href, "data:image/png;base64,AAAA");
  assert.equal(link?.filename, "image.png");
  assert.equal(chatFileLink("data:image/jpeg;base64,AAAA")?.filename, "image.jpeg");
});

test("data:image/svg+xml and other data: URIs are not treated as files", () => {
  assert.equal(chatFileLink("data:image/svg+xml;base64,AAAA"), null);
  assert.equal(chatFileLink("data:text/html;base64,AAAA"), null);
});
