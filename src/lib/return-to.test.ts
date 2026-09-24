import assert from "node:assert/strict";
import test from "node:test";

import { safeReturnTo } from "./return-to";

test("a same-origin path passes through unchanged", () => {
  assert.equal(safeReturnTo("/game?channelId=1"), "/game?channelId=1");
});

test("an absolute URL falls back", () => {
  assert.equal(safeReturnTo("https://evil.com"), "/channels");
});

test("a protocol-relative URL falls back", () => {
  // `//evil.com` starts with `/`, but the browser navigates to https://evil.com.
  assert.equal(safeReturnTo("//evil.com"), "/channels");
  assert.equal(safeReturnTo("/\\evil.com"), "/channels");
});

test("an empty value falls back, and the fallback is configurable", () => {
  assert.equal(safeReturnTo(null), "/channels");
  assert.equal(safeReturnTo(undefined), "/channels");
  assert.equal(safeReturnTo(""), "/channels");
  assert.equal(safeReturnTo(null, "/"), "/");
});

test("a value containing a newline falls back", () => {
  assert.equal(safeReturnTo("/game\r\nSet-Cookie: a=b"), "/channels");
});

test("a value containing a tab character falls back", () => {
  // A browser's URL parser **strips** tabs and newlines from a URL. `/\t/evil.com` starts with
  // `/` and isn't `//`, so it passed the old check, but the browser reads the rendered href as
  // `//evil.com` and navigates to a different origin.
  assert.equal(safeReturnTo("/\t/evil.com"), "/channels");
  assert.equal(safeReturnTo("/" + String.fromCharCode(9) + "/evil.com"), "/channels");
});

test("adding an origin check still lets an ordinary path through unchanged", () => {
  // The belt-and-braces `new URL(value, "http://x")` check must not block a normal path — its
  // query, hash, and encoded characters all have to survive intact.
  assert.equal(
    safeReturnTo("/gateways?new=1&returnTo=%2Fgame"),
    "/gateways?new=1&returnTo=%2Fgame",
  );
  assert.equal(safeReturnTo("/game#top"), "/game#top");
});
