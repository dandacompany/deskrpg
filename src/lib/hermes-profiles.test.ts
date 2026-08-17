import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildProfileClient, mapValidationError } from "./hermes-profiles";
import { encryptGatewayToken } from "./gateway-resources";
import { HermesError } from "./hermes/hermes-client";

describe("buildProfileClient", () => {
  test("decrypts the stored token and scopes the URL to the profile", async () => {
    const tokenEncrypted = encryptGatewayToken("plain-key-1234567890");
    let seen: { url: string; auth: string | null } = { url: "", auth: null };

    const fetchImpl = async (u: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(u), auth: new Headers(init?.headers).get("Authorization") };
      return new Response(JSON.stringify({ features: {}, endpoints: {} }), { status: 200 });
    };

    const client = buildProfileClient({
      baseUrl: "http://gw:8642",
      profileName: "sophie",
      tokenEncrypted,
      fetchImpl: fetchImpl as typeof fetch,
    });
    await client.getCapabilities();

    assert.equal(seen.url, "http://gw:8642/p/sophie/v1/capabilities");
    assert.equal(seen.auth, "Bearer plain-key-1234567890");
  });
});

describe("mapValidationError", () => {
  test("maps HermesError codes to persisted validation statuses", () => {
    assert.equal(mapValidationError(new HermesError("unauthorized", "x", 401)), "unauthorized");
    assert.equal(mapValidationError(new HermesError("unknown_profile", "x", 404)), "unknown_profile");
    assert.equal(mapValidationError(new HermesError("unreachable", "x", 0)), "unreachable");
    assert.equal(mapValidationError(new HermesError("http_error", "x", 500)), "error");
  });

  test("maps a non-Hermes throw to a generic error", () => {
    assert.equal(mapValidationError(new Error("boom")), "error");
  });
});
