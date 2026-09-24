import test from "node:test";
import assert from "node:assert/strict";

import { discoverLocalProfiles } from "./local-discovery";

const BASE = "http://127.0.0.1:8642";

test("discoverLocalProfiles", async (t) => {
  await t.test("combines the filesystem and the gateway to decide", async () => {
    // acestep_output has the same layout as a profile in practice, but the gateway does not
    // serve it. Trusting only the filesystem would present it as a profile.
    const result = await discoverLocalProfiles({
      baseUrl: BASE,
      localProfiles: [
        { name: "sophie", hasToken: true },
        { name: "acestep_output", hasToken: true },
      ],
      registeredNames: [],
      probe: async (_base, profile) => (profile === "sophie" ? "hermes" : "not-hermes"),
    });
    assert.deepEqual(result, [
      {
        name: "sophie",
        hasToken: true,
        servedByGateway: true,
        alreadyRegistered: false,
      },
      {
        name: "acestep_output",
        hasToken: true,
        servedByGateway: false,
        alreadyRegistered: false,
      },
    ]);
  });

  await t.test("marks names that are already registered", async () => {
    const result = await discoverLocalProfiles({
      baseUrl: BASE,
      localProfiles: [{ name: "danvi", hasToken: true }],
      registeredNames: ["danvi"],
      probe: async () => "hermes",
    });
    assert.equal(result[0].alreadyRegistered, true);
  });

  await t.test("still returns the list when the probe fails — servedByGateway=false", async () => {
    const result = await discoverLocalProfiles({
      baseUrl: BASE,
      localProfiles: [{ name: "sophie", hasToken: true }],
      registeredNames: [],
      probe: async () => "unreachable",
    });
    assert.deepEqual(result, [
      {
        name: "sophie",
        hasToken: true,
        servedByGateway: false,
        alreadyRegistered: false,
      },
    ]);
  });

  await t.test("never includes tokens in the return value", async () => {
    const result = await discoverLocalProfiles({
      baseUrl: BASE,
      localProfiles: [{ name: "sophie", hasToken: true }],
      registeredNames: [],
      probe: async () => "hermes",
    });
    assert.equal(JSON.stringify(result).includes("API_SERVER_KEY"), false);
    assert.deepEqual(Object.keys(result[0]).sort(), [
      "alreadyRegistered",
      "hasToken",
      "name",
      "servedByGateway",
    ]);
  });
});
