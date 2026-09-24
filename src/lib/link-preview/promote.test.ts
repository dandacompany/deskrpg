import { test } from "node:test";
import assert from "node:assert/strict";

import { soleLinkUrl } from "./promote";

const text = (value: string) => ({ type: "text" as const, value });
const link = (href: string, label = href) => ({
  type: "element" as const,
  tagName: "a",
  properties: { href },
  children: [text(label)],
});

test("a paragraph with exactly one link whose text is the URL itself is a promotion candidate", () => {
  assert.equal(soleLinkUrl({ children: [link("https://example.com/a")] }), "https://example.com/a");
});

test("whitespace around the link is ignored — markdown leaves line breaks as text", () => {
  assert.equal(
    soleLinkUrl({ children: [text("\n"), link("https://example.com/a"), text("  ")] }),
    "https://example.com/a",
  );
});

test("a link inside a sentence is not promoted", () => {
  assert.equal(soleLinkUrl({ children: [text("참고: "), link("https://example.com/a")] }), null);
});

test("if the text differs from the URL, it's not promoted — a person's own title isn't overwritten by a card", () => {
  assert.equal(soleLinkUrl({ children: [link("https://example.com/a", "여기")] }), null);
});

test("two links means no promotion", () => {
  assert.equal(
    soleLinkUrl({ children: [link("https://e.com/a"), text(" "), link("https://e.com/b")] }),
    null,
  );
});

test("not http(s) means no promotion", () => {
  assert.equal(soleLinkUrl({ children: [link("mailto:a@b.c")] }), null);
});

test("a file link is not promoted — the download icon already does that job", () => {
  assert.equal(soleLinkUrl({ children: [link("https://e.com/a/report.pdf")] }), null);
});

test("doesn't break even with an empty node", () => {
  assert.equal(soleLinkUrl(undefined), null);
  assert.equal(soleLinkUrl({ children: [] }), null);
});
