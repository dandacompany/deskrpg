import assert from "node:assert/strict";
import test from "node:test";

import { diagnoseUnreachable } from "./unreachable-hint";

test("points out a loopback address inside a container", () => {
  for (const baseUrl of [
    "http://127.0.0.1:8643",
    "http://localhost:8643",
    "http://127.0.0.53:8643",
    "http://[::1]:8643",
  ]) {
    assert.equal(
      diagnoseUnreachable({ baseUrl, inContainer: true }),
      "gateway_loopback_in_container",
      baseUrl,
    );
  }
});

test("outside a container, loopback is a valid address", () => {
  // For self-hosting users running locally, 127.0.0.1 is the right answer.
  assert.equal(
    diagnoseUnreachable({ baseUrl: "http://127.0.0.1:8643", inContainer: false }),
    "failed_to_reach_test_endpoint",
  );
});

test("does not flag an external address even inside a container", () => {
  for (const baseUrl of [
    "http://100.123.7.90:8643",
    "http://hermes.example.com",
    "http://10.0.0.5",
  ]) {
    assert.equal(
      diagnoseUnreachable({ baseUrl, inContainer: true }),
      "failed_to_reach_test_endpoint",
      baseUrl,
    );
  }
});

test("does not flag a non-URL — no misdiagnosis by guessing", () => {
  assert.equal(
    diagnoseUnreachable({ baseUrl: "127.0.0.1:8643", inContainer: true }),
    "failed_to_reach_test_endpoint",
  );
});
