import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const drizzleDir = path.join(repoRoot, "drizzle");

function journalTags(): string[] {
  const j = JSON.parse(readFileSync(path.join(drizzleDir, "meta", "_journal.json"), "utf8"));
  return j.entries.map((e: { tag: string }) => e.tag);
}

function sqlTags(): string[] {
  return readdirSync(drizzleDir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => f.replace(/\.sql$/, ""))
    .sort();
}

/**
 * Drizzle 마이그레이터는 `drizzle/` 디렉토리를 스캔하지 않는다 — `meta/_journal.json`
 * 만 읽는다. 그래서 SQL 파일을 손으로 추가하면(drizzle-kit generate 없이) 그 파일은
 * **존재하는데도 실행되지 않고**, 마이그레이터는 자기가 아는 것을 다 했으므로
 * "applied successfully" 를 보고한다.
 *
 * 실제로 0004·0005 가 그렇게 넉 달 가까이 누락됐고, 스테이징에서 앱이
 * `column "local_discovery_opted_in_at" does not exist` 로 500 을 냈다. 조용한 실패가
 * 아니라 **성공을 보고하는 실패**라 배포 로그로는 알 수 없었다.
 */
test("every migration file is listed in the drizzle journal", () => {
  const missing = sqlTags().filter((t) => !journalTags().includes(t));
  assert.deepEqual(
    missing,
    [],
    "저널에 없는 마이그레이션이 있습니다 — 이 파일들은 배포해도 실행되지 않고, " +
      `마이그레이터는 성공을 보고합니다: ${missing.join(", ")}`,
  );
});

test("the journal never names a migration file that is missing", () => {
  const orphan = journalTags().filter((t) => !sqlTags().includes(t));
  assert.deepEqual(orphan, [], `저널이 없는 파일을 가리킵니다: ${orphan.join(", ")}`);
});

test("journal entries stay ordered by idx and by time", () => {
  // 마이그레이터는 이 순서대로 적용한다. 어긋나면 나중 것이 먼저 돌아 스키마가 꼬인다.
  const entries = JSON.parse(readFileSync(path.join(drizzleDir, "meta", "_journal.json"), "utf8"))
    .entries as { idx: number; when: number; tag: string }[];

  entries.forEach((e, i) => {
    assert.equal(e.idx, i, `idx 가 연속이 아닙니다: ${e.tag} 의 idx=${e.idx}, 기대=${i}`);
    if (i > 0) {
      assert.ok(
        e.when > entries[i - 1].when,
        `${e.tag} 의 when 이 앞 항목보다 앞섭니다 — 적용 순서가 뒤집힙니다.`,
      );
    }
  });
});
