import assert from "node:assert/strict";
import test from "node:test";

import { profileLoginUrl } from "./dashboard-link";

test("the profile login link sends the profile to the dashboard Keys screen", () => {
  // The Hermes dashboard picks the managed profile via `?profile=` (measured on 0.21.3: noah is selected even on a
  // fresh open).
  assert.equal(
    profileLoginUrl("https://deskrpg-hermes.example.com", "noah"),
    "https://deskrpg-hermes.example.com/env?profile=noah",
  );
});

test("trims the trailing slash and existing path, and encodes the name", () => {
  assert.equal(
    profileLoginUrl("https://h.example.com/", "a_b-1"),
    "https://h.example.com/env?profile=a_b-1",
  );
  assert.equal(
    profileLoginUrl("https://h.example.com/dash/", "x y"),
    "https://h.example.com/dash/env?profile=x%20y",
  );
});

test("no link when the address is missing or not http(s)", () => {
  assert.equal(profileLoginUrl(null, "noah"), null);
  assert.equal(profileLoginUrl("", "noah"), null);
  assert.equal(profileLoginUrl("javascript:alert(1)", "noah"), null);
  assert.equal(profileLoginUrl("https://h.example.com", ""), null);
});
