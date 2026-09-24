import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  validateAuthSegment,
  validateKeyBody,
  validateToolProviderBody,
} from "./provider-auth-validation";

describe("provider auth input validation", () => {
  it("path segments allow only a narrow character set", () => {
    assert.equal(validateAuthSegment("openai-codex"), true);
    assert.equal(validateAuthSegment("abc_DEF.1-2"), true);
    for (const bad of ["", "a/b", "..%2f", "x".repeat(129), "a b", ".", ".."]) {
      assert.equal(validateAuthSegment(bad), false);
    }
  });
  it("key body accepts only a string value and never puts the value in errors", () => {
    assert.deepEqual(validateKeyBody({ value: "sk-VALUE-123" }), {
      ok: true,
      value: "sk-VALUE-123",
    });
    for (const bad of [
      null,
      {},
      { value: 1 },
      { value: "" },
      { value: "x".repeat(1025) },
      "sk-raw",
      ["sk-arr"],
    ]) {
      const got = validateKeyBody(bad);
      assert.equal(got.ok, false);
      assert.equal(JSON.stringify(got).includes("sk-"), false);
    }
  });
});

describe("validateToolProviderBody — tool provider selection body", () => {
  it("accepts a provider and a key map", () => {
    assert.deepEqual(
      validateToolProviderBody({ provider: "OpenAI TTS", env: { VOICE_TOOLS_OPENAI_KEY: "sk-x" } }),
      { ok: true, provider: "OpenAI TTS", env: { VOICE_TOOLS_OPENAI_KEY: "sk-x" } },
    );
    assert.deepEqual(validateToolProviderBody({ provider: "Microsoft Edge TTS" }), {
      ok: true,
      provider: "Microsoft Edge TTS",
      env: {},
    });
  });

  it("a wrong shape is bad_request and carries no values", () => {
    const secret = "sk-SECRET-should-not-echo";
    for (const input of [
      null,
      [],
      { provider: "" },
      { provider: 1 },
      { provider: "x".repeat(129) },
      { provider: "A", env: [] },
      { provider: "A", env: { lower_case: secret } },
      { provider: "A", env: { OK_KEY: 12 } },
      { provider: "A", env: { OK_KEY: "x".repeat(1025) } },
    ]) {
      const result = validateToolProviderBody(input);
      assert.deepEqual(result, { ok: false, errorCode: "bad_request" });
      assert.equal(JSON.stringify(result).includes(secret), false);
    }
  });
});
