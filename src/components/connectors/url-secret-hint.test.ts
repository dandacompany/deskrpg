import test from "node:test";
import assert from "node:assert/strict";

import { hasSecretQuery } from "./url-secret-hint";

test("flags each secret-looking query key", () => {
  for (const key of [
    "token",
    "key",
    "apikey",
    "api_key",
    "secret",
    "password",
    "access_token",
    "auth",
    "x_api_key",
    "client_secret",
  ]) {
    assert.equal(hasSecretQuery(`https://mcp.example.com/mcp?${key}=abc`), true, key);
  }
});

test("matches keys regardless of case and position", () => {
  assert.equal(hasSecretQuery("https://mcp.example.com/mcp?Token=abc"), true);
  assert.equal(hasSecretQuery("https://mcp.example.com/mcp?page=2&APIKEY=abc"), true);
});

test("does not flag harmless, empty, or unparsable input", () => {
  for (const url of [
    "https://mcp.example.com/mcp",
    "https://mcp.example.com/mcp?page=2",
    "https://mcp.example.com/mcp?token=",
    "https://mcp.example.com/mcp?token",
    "https://mcp.example.com/mcp#token=abc",
    "",
    "not a url?token=abc",
  ]) {
    assert.equal(hasSecretQuery(url), false, url);
  }
});
