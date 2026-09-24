import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_FEMALE_OFFICE_LOOK_ID,
  DEFAULT_OFFICE_LOOK_ID,
  defaultOfficeAppearance,
  isOfficeLookId,
  normalizeOfficeAppearance,
  validateOfficeAppearance,
} from "./office-appearance";
import { OFFICE_LOOKS, officeLookAppearance } from "./office-looks";

const female = OFFICE_LOOKS.find((look) => look.bodyType === "female")!;

test("the two default looks are in the real list and have the right gender", () => {
  assert.equal(OFFICE_LOOKS.find((l) => l.id === DEFAULT_OFFICE_LOOK_ID)?.bodyType, "male");
  assert.equal(
    OFFICE_LOOKS.find((l) => l.id === DEFAULT_FEMALE_OFFICE_LOOK_ID)?.bodyType,
    "female",
  );
  assert.deepEqual(defaultOfficeAppearance(), { officeLookId: "office-jun", bodyType: "male" });
  assert.notEqual(defaultOfficeAppearance(), defaultOfficeAppearance());
});

test("the conversion rule table — old appearances fold by gender and layer keys are dropped", () => {
  const legacyLayers = { layers: { body: { itemKey: "body", variant: "light" } } };
  assert.deepEqual(normalizeOfficeAppearance({ bodyType: "female", ...legacyLayers }), {
    officeLookId: "office-nari",
    bodyType: "female",
  });
  assert.deepEqual(normalizeOfficeAppearance({ bodyType: "male", ...legacyLayers }), {
    officeLookId: "office-jun",
    bodyType: "male",
  });
  assert.deepEqual(normalizeOfficeAppearance({ ...legacyLayers }), {
    officeLookId: "office-jun",
    bodyType: "male",
  });
  assert.deepEqual(normalizeOfficeAppearance({ bodyType: "robot" }), {
    officeLookId: "office-jun",
    bodyType: "male",
  });
  assert.deepEqual(normalizeOfficeAppearance({ officeLookId: "missing", bodyType: "female" }), {
    officeLookId: "office-nari",
    bodyType: "female",
  });
  assert.deepEqual(normalizeOfficeAppearance({}), { officeLookId: "office-jun", bodyType: "male" });
  assert.deepEqual(normalizeOfficeAppearance(12), { officeLookId: "office-jun", bodyType: "male" });
  assert.deepEqual(normalizeOfficeAppearance([]), { officeLookId: "office-jun", bodyType: "male" });
});

test("valid looks are kept and a bodyType mismatch is overwritten with the look's value", () => {
  assert.deepEqual(normalizeOfficeAppearance({ officeLookId: female.id, bodyType: "male" }), {
    officeLookId: female.id,
    bodyType: "female",
  });
  assert.deepEqual(normalizeOfficeAppearance({ officeLookId: female.id }), {
    officeLookId: female.id,
    bodyType: "female",
  });
  for (const look of OFFICE_LOOKS)
    assert.deepEqual(normalizeOfficeAppearance(officeLookAppearance(look.id)), {
      officeLookId: look.id,
      bodyType: look.bodyType,
    });
});

test("extra keys are preserved", () => {
  assert.deepEqual(
    normalizeOfficeAppearance({ officeLookId: "office-jun", bodyType: "male", accent: "#f00" }),
    { officeLookId: "office-jun", bodyType: "male", accent: "#f00" },
  );
});

test("strings follow the same rules after parsing, and parse failures give the default look", () => {
  assert.deepEqual(
    normalizeOfficeAppearance(JSON.stringify({ officeLookId: female.id, bodyType: "male" })),
    { officeLookId: female.id, bodyType: "female" },
  );
  assert.deepEqual(normalizeOfficeAppearance(JSON.stringify({ bodyType: "female" })), {
    officeLookId: "office-nari",
    bodyType: "female",
  });
  assert.deepEqual(normalizeOfficeAppearance("{broken"), {
    officeLookId: "office-jun",
    bodyType: "male",
  });
  assert.deepEqual(normalizeOfficeAppearance("null"), {
    officeLookId: "office-jun",
    bodyType: "male",
  });
});

test("null and undefined stay null", () => {
  assert.equal(normalizeOfficeAppearance(null), null);
  assert.equal(normalizeOfficeAppearance(undefined), null);
});

test("normalization does not mutate the input", () => {
  const input = { officeLookId: female.id, bodyType: "male", layers: {} };
  const copy = structuredClone(input);
  normalizeOfficeAppearance(input);
  assert.deepEqual(input, copy);
});

test("REST validation — rejects a missing or unknown officeLookId, lets a bodyType mismatch pass", () => {
  assert.equal(validateOfficeAppearance({ officeLookId: "office-jun", bodyType: "male" }), null);
  assert.equal(validateOfficeAppearance({ officeLookId: female.id, bodyType: "male" }), null);
  assert.equal(validateOfficeAppearance({ officeLookId: female.id }), null);
  for (const bad of [
    null,
    undefined,
    "garbage",
    12,
    [],
    {},
    { bodyType: "male" },
    { officeLookId: "" },
    { officeLookId: "missing", bodyType: "male" },
    { officeLookId: 3 },
    { bodyType: "male", layers: { body: { itemKey: "body", variant: "light" } } },
  ])
    assert.equal(typeof validateOfficeAppearance(bad), "string", JSON.stringify(bad));
  assert.equal(isOfficeLookId("office-jun"), true);
  assert.equal(isOfficeLookId("nope"), false);
  assert.equal(isOfficeLookId(undefined), false);
});

test("officeLookAppearance produces only the two canonical keys", () => {
  for (const look of OFFICE_LOOKS)
    assert.deepEqual(officeLookAppearance(look.id), {
      officeLookId: look.id,
      bodyType: look.bodyType,
    });
});
