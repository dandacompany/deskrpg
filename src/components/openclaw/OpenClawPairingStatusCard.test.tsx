import test from "node:test";
import assert from "node:assert/strict";

import {
  buildOpenClawPairingApproveCommand,
  normalizeOpenClawPairingStatus,
} from "./OpenClawPairingStatusCard";

test("buildOpenClawPairingApproveCommand uses the supported CLI form", () => {
  assert.equal(
    buildOpenClawPairingApproveCommand("req-123"),
    "openclaw devices approve req-123",
  );
});

test("normalizeOpenClawPairingStatus accepts underscore and hyphen forms", () => {
  assert.equal(normalizeOpenClawPairingStatus("pairing_required"), "pairing-required");
  assert.equal(normalizeOpenClawPairingStatus("pairing-required"), "pairing-required");
  assert.equal(normalizeOpenClawPairingStatus("connected"), "connected");
});
