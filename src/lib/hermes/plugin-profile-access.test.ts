import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { selectProfileToken } from "./plugin-profile-access";

describe("selectProfileToken", () => {
  it("decrypts and returns the registered profile's token", () => {
    const got = selectProfileToken({
      rows: [{ profileName: "noah", tokenEncrypted: "enc-noah" }],
      profileName: "noah",
      decrypt: (v) => `dec(${v})`,
    });
    assert.deepEqual(got, { ok: true, profileToken: "dec(enc-noah)" });
  });

  it("an unregistered profile is no_profile", () => {
    // Must not fall back to the default key here — sending the default key on a profile-scoped path
    // makes Hermes return 401, and the user gets the wrong diagnosis 'the token is wrong'.
    const got = selectProfileToken({
      rows: [{ profileName: "sophie", tokenEncrypted: "enc-sophie" }],
      profileName: "noah",
      decrypt: (v) => `dec(${v})`,
    });
    assert.deepEqual(got, { ok: false, reason: "no_profile" });
  });

  it("a decryption failure is no_profile — doesn't throw", () => {
    const got = selectProfileToken({
      rows: [{ profileName: "noah", tokenEncrypted: "corrupt" }],
      profileName: "noah",
      decrypt: () => {
        throw new Error("Invalid gateway token payload");
      },
    });
    assert.deepEqual(got, { ok: false, reason: "no_profile" });
  });
});
