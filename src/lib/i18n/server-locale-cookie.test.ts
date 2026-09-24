import assert from "node:assert/strict";
import test from "node:test";

import { readLocaleCookie } from "./server";

test("pulls the display language out of the handshake cookie", () => {
  assert.equal(readLocaleCookie("token=abc; deskrpg-locale=ko"), "ko");
  assert.equal(readLocaleCookie("deskrpg-locale=ja-JP;token=x"), "ja");
});

test("null when the cookie is missing or empty — never guesses", () => {
  assert.equal(readLocaleCookie(undefined), null);
  assert.equal(readLocaleCookie("token=abc"), null);
  assert.equal(readLocaleCookie("deskrpg-locale="), null);
  assert.equal(readLocaleCookie("xdeskrpg-locale=ko"), null);
});

test("a cookie with broken encoding is null instead of throwing — one bad cookie doesn't kill the socket handler", () => {
  assert.equal(readLocaleCookie("deskrpg-locale=%E0%A4%A"), null);
  assert.equal(readLocaleCookie("deskrpg-locale=%E0%A4%A; token=x"), null);
});
