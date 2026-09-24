import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { OFFICE_LOOKS } from "@/game/three/office-looks";

import { pickOfficeLookForNewProfile } from "./profile-look-assignment";

const ALL_IDS = OFFICE_LOOKS.map((look) => look.id);
/** Builds values in the shape of the DB's `appearance` column. SQLite gives a JSON string, PG gives an object. */
const asAppearance = (ids: string[]) =>
  ids.map((id, i) =>
    i % 2 === 0 ? { officeLookId: id, bodyType: "male" } : JSON.stringify({ officeLookId: id }),
  );

describe("pickOfficeLookForNewProfile — auto-assigns an appearance to a new employee", () => {
  it("picks a look no one on this gateway has used yet", () => {
    const used = asAppearance(ALL_IDS.slice(0, ALL_IDS.length - 1));
    const picked = pickOfficeLookForNewProfile(used, () => 0);
    assert.equal(picked.officeLookId, ALL_IDS[ALL_IDS.length - 1]);
  });

  it("if several looks are unused, picks randomly among them", () => {
    const unused = ALL_IDS.slice(0, 3);
    const used = asAppearance(ALL_IDS.slice(3));
    const picks = new Set(
      [0, 0.34, 0.67, 0.99].map((r) => pickOfficeLookForNewProfile(used, () => r).officeLookId),
    );
    assert.deepEqual([...picks].sort(), [...unused].sort());
  });

  it("if all are used, picks from the whole set even with overlap — never leaves an employee with no appearance", () => {
    const picked = pickOfficeLookForNewProfile(asAppearance(ALL_IDS), () => 0.5);
    assert.ok(ALL_IDS.includes(picked.officeLookId));
  });

  it("ignores unknown ids and nulls mixed in", () => {
    const picked = pickOfficeLookForNewProfile(
      [null, { officeLookId: "office-unknown" }, "{broken", 42],
      () => 0,
    );
    assert.equal(picked.officeLookId, ALL_IDS[0]);
  });

  it("returns the canonical shape (the two keys officeLookId and bodyType)", () => {
    const picked = pickOfficeLookForNewProfile([], () => 0);
    const look = OFFICE_LOOKS[0];
    assert.deepEqual(picked, { officeLookId: look.id, bodyType: look.bodyType });
  });

  it("stays in range even when random is close to 1", () => {
    const picked = pickOfficeLookForNewProfile([], () => 0.999999);
    assert.equal(picked.officeLookId, ALL_IDS[ALL_IDS.length - 1]);
  });
});
