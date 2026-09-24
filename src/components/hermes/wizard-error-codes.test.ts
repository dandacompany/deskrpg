import assert from "node:assert/strict";
import { describe, it } from "node:test";

import en from "@/lib/i18n/locales/en";
import ja from "@/lib/i18n/locales/ja";
import ko from "@/lib/i18n/locales/ko";
import zh from "@/lib/i18n/locales/zh";

import {
  WIZARD_ERROR_CODES,
  WIZARD_ERROR_MESSAGE_KEYS,
  getWizardErrorMessage,
  isWizardErrorCode,
  wizardErrorMessageKey,
} from "./wizard-error-codes";

// The hole this test plugs: `src/lib/i18n/error-codes.test.ts`'s "every error code a
// route emits is registered" guard only scans for a **literal** `errorCode: "..."` in
// route source via regex. The plugin proxy routes carry `res.failure.code` through as a
// dynamic value, so they're outside that guard's view — a missing translation passes silently.
describe("wizard-error-codes — coverage across the 4 locales", () => {
  it("every registered code has text in all 4 locales", () => {
    const locales: Array<[string, Record<string, string>]> = [
      ["ko", ko],
      ["en", en],
      ["ja", ja],
      ["zh", zh],
    ];
    const missing: string[] = [];
    for (const code of WIZARD_ERROR_CODES) {
      const key = WIZARD_ERROR_MESSAGE_KEYS[code];
      for (const [lang, dict] of locales) {
        if (!dict[key]) missing.push(`${lang}: ${key} (${code})`);
      }
    }
    assert.deepEqual(missing, [], `번역이 없는 마법사 에러코드:\n  ${missing.join("\n  ")}`);
  });

  it("the unknown fallback key is also present in all 4 locales", () => {
    const locales: Array<[string, Record<string, string>]> = [
      ["ko", ko],
      ["en", en],
      ["ja", ja],
      ["zh", zh],
    ];
    for (const [lang, dict] of locales) {
      assert.ok(dict["hermes.wizard.error.unknown"], `${lang} 에 unknown fallback 이 없습니다`);
    }
  });

  it("an unregistered code collapses to unknown", () => {
    assert.equal(isWizardErrorCode("something_never_registered"), false);
    assert.equal(
      wizardErrorMessageKey("something_never_registered"),
      "hermes.wizard.error.unknown",
    );
    assert.equal(wizardErrorMessageKey(null), "hermes.wizard.error.unknown");
    assert.equal(wizardErrorMessageKey(undefined), "hermes.wizard.error.unknown");
  });

  it("a registered code maps to a stable key", () => {
    assert.equal(
      wizardErrorMessageKey("profile_has_service"),
      "hermes.wizard.error.profileHasService",
    );
    assert.equal(
      wizardErrorMessageKey("revision_conflict"),
      "hermes.wizard.error.revisionConflict",
    );
    assert.equal(
      wizardErrorMessageKey("identity_unreadable"),
      "hermes.wizard.error.identityUnreadable",
    );
  });

  it("getWizardErrorMessage returns text translated via t()", () => {
    const t = (key: string) => ko[key] ?? key;
    assert.equal(
      getWizardErrorMessage(t, "already_exists"),
      ko["hermes.wizard.error.alreadyExists"],
    );
    assert.equal(getWizardErrorMessage(t, "totally_unknown"), ko["hermes.wizard.error.unknown"]);
  });
});

describe("defect 8 — revision_mismatch points to the same text as revision_conflict", () => {
  // The spec wrote `revision_conflict`, but the plugin emits `revision_mismatch`
  // (observed live by team-lead, deskrpg_plugin/identity.py:142). Fixing the plugin would
  // break gateways running the old version, so both codes are registered pointing at the same key.
  it("both codes map to the same translation key", () => {
    assert.equal(
      wizardErrorMessageKey("revision_mismatch"),
      wizardErrorMessageKey("revision_conflict"),
    );
    assert.equal(
      wizardErrorMessageKey("revision_mismatch"),
      "hermes.wizard.error.revisionConflict",
    );
  });

  it("is actually registered in the WIZARD_ERROR_CODES list", () => {
    assert.ok(
      (WIZARD_ERROR_CODES as readonly string[]).includes("revision_mismatch"),
      "revision_mismatch 가 목록에 없으면 신버전 플러그인의 409 가 unknown 으로 접힌다",
    );
  });
});
