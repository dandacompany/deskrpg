import assert from "node:assert/strict";
import test from "node:test";

import internalTransport from "./internal-transport.js";

const {
  buildInternalAuthHeaders,
  getInternalSocketHostname,
  isInternalRequestAuthorized,
} = internalTransport;

test("internal socket hostname defaults to loopback", () => {
  assert.equal(getInternalSocketHostname({}), "127.0.0.1");
});

test("internal socket hostname prefers explicit override", () => {
  assert.equal(
    getInternalSocketHostname({ INTERNAL_HOSTNAME: "0.0.0.0", HOSTNAME: "127.0.0.1" }),
    "0.0.0.0",
  );
});

test("internal auth headers include the configured secret", () => {
  assert.deepEqual(buildInternalAuthHeaders("secret-token"), {
    "x-deskrpg-internal-secret": "secret-token",
  });
});

test("internal requests are rejected when secret is missing or mismatched", () => {
  assert.equal(isInternalRequestAuthorized(new Headers(), "secret-token"), false);
  assert.equal(
    isInternalRequestAuthorized(new Headers({ "x-deskrpg-internal-secret": "wrong" }), "secret-token"),
    false,
  );
  assert.equal(
    isInternalRequestAuthorized(new Headers({ "x-deskrpg-internal-secret": "secret-token" }), "secret-token"),
    true,
  );
});
