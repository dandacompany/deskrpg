import assert from "node:assert/strict";
import test from "node:test";

import { runFailureCause } from "./run-failure-cause";

// Measured on staging (Hermes 0.21.2) with an expired openai-codex sign-in; the key is masked.
const EXPIRED_SIGN_IN =
  "ChatGPT or Codex Subscription rejected your sign-in, so the model can't be reached. " +
  "Sign in again: `hermes -p sophie auth add openai-codex --type oauth`.\n\n" +
  "Provider said: HTTP 401: Incorrect API key provided: sk-test*****.";

test("an expired provider sign-in needs a new sign-in", () => {
  assert.equal(runFailureCause(EXPIRED_SIGN_IN), "provider_auth");
  assert.equal(runFailureCause("Error code: 401 - invalid_api_key"), "provider_auth");
  assert.equal(runFailureCause("token_invalidated"), "provider_auth");
});

test("a provider limit is a usage limit, not a sign-in problem", () => {
  assert.equal(runFailureCause("HTTP 429: The usage limit has been reached"), "usage_limit");
  assert.equal(runFailureCause("insufficient credits"), "usage_limit");
  assert.equal(runFailureCause("Rate limit exceeded"), "usage_limit");
});

test("a model the provider does not serve is a model error", () => {
  assert.equal(runFailureCause("The model `gpt-9` does not exist"), "model_error");
  assert.equal(runFailureCause("model_not_found"), "model_error");
  assert.equal(runFailureCause("Unknown model: foo"), "model_error");
});

test("anything else has no known cause", () => {
  assert.equal(runFailureCause("Hermes run failed"), null);
  assert.equal(runFailureCause(""), null);
  assert.equal(runFailureCause(null), null);
  assert.equal(runFailureCause(undefined), null);
});
