import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { attachKeyStorage, stripApiKey } from "./plugin-provision";

describe("stripApiKey", () => {
  it("moves only known shapes of the worker plugin result (including the 0.16.0 skip)", () => {
    const skipped = stripApiKey({
      name: "noah",
      keyIssued: true,
      workerPlugin: { skipped: "propagation_disabled" },
    });
    assert.deepEqual(skipped.workerPlugin, { skipped: "propagation_disabled" });
    const applied = stripApiKey({
      name: "noah",
      keyIssued: true,
      workerPlugin: { profile: "noah", link: "linked", enabled: "added" },
    });
    assert.deepEqual(applied.workerPlugin, { profile: "noah", link: "linked", enabled: "added" });
    assert.equal(stripApiKey({ name: "noah", keyIssued: true }).workerPlugin, undefined);
  });

  it("strips apiKey from the response", () => {
    // This value is a credential that opens one profile on the gateway. Once it reaches the browser,
    // it lingers in places we can't control (console, extensions, error reporters).
    const out = stripApiKey({ name: "noah", apiKey: "k".repeat(40), keyIssued: true });
    assert.deepEqual(out, { name: "noah", keyIssued: true });
    assert.equal("apiKey" in out, false);
  });

  it("keeps a key issuance failure together with the fact that the profile was created", () => {
    // If the failure is swallowed, the user retries with the same name without knowing the profile exists
    // and hits 409.
    const out = stripApiKey({
      name: "noah",
      keyIssued: false,
      keyError: ".env 을 쓸 수 없다: PermissionError",
    });
    assert.deepEqual(out, {
      name: "noah",
      keyIssued: false,
      keyError: ".env 을 쓸 수 없다: PermissionError",
    });
  });

  it("no key remains in the serialized result", () => {
    const secret = "s".repeat(40);
    const json = JSON.stringify(stripApiKey({ name: "n", apiKey: secret, keyIssued: true }));
    assert.equal(json.includes(secret), false);
  });
});

describe("attachKeyStorage", () => {
  it("attaches only keyStored:false when no key was issued, meaning storage was not attempted", () => {
    const safe = stripApiKey({ name: "noah", keyIssued: false, keyError: "boom" });
    const out = attachKeyStorage(safe, null);
    assert.deepEqual(out, { name: "noah", keyIssued: false, keyError: "boom", keyStored: false });
  });

  it("keyStored:true when storage succeeds", () => {
    const safe = stripApiKey({ name: "noah", apiKey: "k".repeat(40), keyIssued: true });
    const out = attachKeyStorage(safe, { ok: true });
    assert.deepEqual(out, { name: "noah", keyIssued: true, keyStored: true });
  });

  it("keyStored:false with a reason when storage is rejected because the user is not the gateway owner", () => {
    // Verdict B: the profile really was created, so keep 201, but don't hide the storage failure —
    // hiding it leaves the profile permanently in a state where it can neither be recreated (same name 409)
    // nor opened.
    const safe = stripApiKey({ name: "noah", apiKey: "k".repeat(40), keyIssued: true });
    const out = attachKeyStorage(safe, { ok: false, reason: "forbidden" });
    assert.deepEqual(out, {
      name: "noah",
      keyIssued: true,
      keyStored: false,
      keyStoredError: "forbidden",
    });
  });
});
