import assert from "node:assert/strict";
import test from "node:test";

import {
  ACCOUNT_PASSWORD_MIN_LENGTH,
  CHANNEL_PASSWORD_MIN_LENGTH,
  generateChannelInviteCode,
  isAccountPasswordValid,
  isChannelPasswordValid,
} from "./security-policy";

test("account and channel passwords require at least eight characters", () => {
  assert.equal(ACCOUNT_PASSWORD_MIN_LENGTH, 8);
  assert.equal(CHANNEL_PASSWORD_MIN_LENGTH, 8);
  assert.equal(isAccountPasswordValid("1234567"), false);
  assert.equal(isAccountPasswordValid("12345678"), true);
  assert.equal(isChannelPasswordValid("1234567"), false);
  assert.equal(isChannelPasswordValid("12345678"), true);
});

test("channel invite codes are long, URL-safe, and not decimal-base36 Math.random output", () => {
  const code = generateChannelInviteCode();
  assert.match(code, /^[A-Za-z0-9_-]{16,}$/);
  assert.equal(code.includes("."), false);
});

test("channel invite codes are not reused across successive generations", () => {
  const generated = new Set(Array.from({ length: 8 }, () => generateChannelInviteCode()));
  assert.equal(generated.size, 8);
});
