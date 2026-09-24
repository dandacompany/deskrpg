import test from "node:test";
import assert from "node:assert/strict";
import { OFFICE_ENVIRONMENTS, environmentLabel } from "./office-environments";

test("environmentLabel keeps ko/en from the data and gives ja/zh without Hangul", () => {
  for (const env of OFFICE_ENVIRONMENTS) {
    assert.deepEqual(environmentLabel(env, "ko"), {
      name: env.nameKo,
      description: env.descriptionKo,
    });
    assert.deepEqual(environmentLabel(env, null), {
      name: env.nameEn,
      description: env.descriptionEn,
    });
    for (const locale of ["ja", "zh"]) {
      const { name, description } = environmentLabel(env, locale);
      assert.ok(name && description, `${env.id} ${locale}`);
      assert.doesNotMatch(`${name} ${description}`, /[가-힣]/);
    }
  }
});
