import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { validateConfigPatch, validateCreateOptions } from "./validation";

describe("validateConfigPatch — picker keys", () => {
  it("passes enabledToolsets and disabledSkills", () => {
    const got = validateConfigPatch({ enabledToolsets: ["web"], disabledSkills: [] });
    assert.equal(got.ok, true);
  });
});

describe("validateCreateOptions", () => {
  it("cloneFrom accepts only default", () => {
    assert.deepEqual(validateCreateOptions({ name: "n" }), { ok: true });
    assert.deepEqual(validateCreateOptions({ name: "n", cloneFrom: "default" }), {
      ok: true,
      cloneFrom: "default",
    });
    assert.deepEqual(validateCreateOptions({ name: "n", cloneFrom: "mia" }), {
      ok: false,
      errorCode: "bad_request",
    });
    assert.deepEqual(validateCreateOptions({ name: "n", cloneFrom: true }), {
      ok: false,
      errorCode: "bad_request",
    });
  });
  it("cloneKeys accepts only referenced and api_keys, and only together with cloneFrom", () => {
    assert.deepEqual(
      validateCreateOptions({ name: "n", cloneFrom: "default", cloneKeys: "api_keys" }),
      { ok: true, cloneFrom: "default", cloneKeys: "api_keys" },
    );
    assert.deepEqual(
      validateCreateOptions({ name: "n", cloneFrom: "default", cloneKeys: "referenced" }),
      { ok: true, cloneFrom: "default", cloneKeys: "referenced" },
    );
    for (const bad of [
      { name: "n", cloneFrom: "default", cloneKeys: "all" },
      { name: "n", cloneFrom: "default", cloneKeys: ["api_keys"] },
      { name: "n", cloneKeys: "api_keys" },
    ]) {
      assert.deepEqual(validateCreateOptions(bad), { ok: false, errorCode: "bad_request" });
    }
  });
});
