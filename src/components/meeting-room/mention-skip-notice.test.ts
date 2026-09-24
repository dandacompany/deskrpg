import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { MENTION_SKIP_I18N_KEY, mentionSkipI18nKey } from "./mention-skip-notice";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** Reads the locale file as source text — importing it would drag in a next/ runtime dependency. */
function localeSource(lang: string): string {
  return readFileSync(path.join(repoRoot, `src/lib/i18n/locales/${lang}.ts`), "utf8");
}

const LANGS = ["ko", "ja", "zh", "en"];

describe("skipped-mention notice — i18n key per reason", () => {
  test("picks a different key for each reason", () => {
    assert.equal(mentionSkipI18nKey("quota_exhausted"), "meeting.mentionSkipped.quotaExhausted");
    assert.equal(mentionSkipI18nKey("backend_failing"), "meeting.mentionSkipped.backendFailing");
  });

  test("two reasons are not flattened into the same key", () => {
    // The engine sends "backend died" and "ran out of quota" as distinct reasons, but if the
    // last step emits the same message for both, that distinction never reaches the user.
    const keys = Object.values(MENTION_SKIP_I18N_KEY);
    assert.equal(new Set(keys).size, keys.length, `키가 중복됩니다: ${JSON.stringify(keys)}`);
  });

  for (const lang of LANGS) {
    test(`${lang} 로케일에 모든 사유의 문구가 있다`, () => {
      const src = localeSource(lang);
      for (const key of Object.values(MENTION_SKIP_I18N_KEY)) {
        assert.ok(
          src.includes(`"${key}"`),
          `${lang}.ts 에 "${key}" 가 없습니다 — 그 언어 사용자에게는 키 문자열이 그대로 보입니다.`,
        );
      }
    });

    test(`${lang} 문구가 {name} 자리표시자를 쓴다`, () => {
      // The client calls t(key, { name }). If the placeholder is missing, "who" was skipped
      // disappears, making the notice useless in a meeting with multiple participants.
      const src = localeSource(lang);
      for (const key of Object.values(MENTION_SKIP_I18N_KEY)) {
        // Don't search line by line — if the formatter splits a long entry across a key line
        // and a value line, the value moves to the next line and this would wrongly fail with
        // "{name} is missing" instead of "line not found".
        const m = src.match(
          new RegExp(
            `"${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")`,
          ),
        );
        assert.ok(m, `${lang}.ts 에서 "${key}" 의 값을 찾지 못했습니다.`);
        assert.ok(
          m![1].includes("{name}"),
          `${lang}.ts 의 "${key}" 에 {name} 이 없습니다: ${m![1]}`,
        );
      }
    });
  }
});
