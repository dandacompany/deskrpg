import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { MENTION_SKIP_I18N_KEY, mentionSkipI18nKey } from "./mention-skip-notice";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** 로케일 파일을 소스 텍스트로 읽는다 — import 하면 next/ 런타임 의존이 딸려 온다. */
function localeSource(lang: string): string {
  return readFileSync(path.join(repoRoot, `src/lib/i18n/locales/${lang}.ts`), "utf8");
}

const LANGS = ["ko", "ja", "zh", "en"];

describe("건너뛴 지목 안내 — 사유별 i18n 키", () => {
  test("사유마다 서로 다른 키를 고른다", () => {
    assert.equal(mentionSkipI18nKey("quota_exhausted"), "meeting.mentionSkipped.quotaExhausted");
    assert.equal(mentionSkipI18nKey("backend_failing"), "meeting.mentionSkipped.backendFailing");
  });

  test("두 사유가 같은 키로 뭉개지지 않는다", () => {
    // 엔진이 "백엔드가 죽었다"와 "할당량을 다 썼다"를 구분해 보내는데 마지막 한 칸에서
    // 같은 문구가 나가면 그 구분이 사용자에게 도달하지 않는다.
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
      // 클라이언트는 t(key, { name }) 로 부른다. 자리표시자가 빠지면 "누가" 건너뛰어졌는지가
      // 사라져, 참가자가 여럿인 회의에서 안내가 쓸모없어진다.
      const src = localeSource(lang);
      for (const key of Object.values(MENTION_SKIP_I18N_KEY)) {
        // 줄 단위로 찾지 않는다 — 포매터가 긴 항목을 키와 값 두 줄로 쪼개면
        // 값이 다음 줄로 내려가 "줄을 못 찾았다"가 아니라 "{name} 이 없다"로 잘못 실패한다.
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
