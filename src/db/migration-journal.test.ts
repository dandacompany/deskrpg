import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import { getTableName } from "drizzle-orm";
import * as schema from "./schema";

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
 * The Drizzle migrator does not scan the `drizzle/` directory — it only reads
 * `meta/_journal.json`. So if a SQL file is added by hand (without drizzle-kit generate), that
 * file **exists but never runs**, and the migrator reports "applied successfully" because it
 * already did everything it knows about.
 *
 * In practice, 0004/0005 went missing this way for close to four months, and staging started
 * returning 500s with `column "local_discovery_opted_in_at" does not exist`. This isn't a silent
 * failure — it's a **failure that reports success** — so the deploy logs couldn't reveal it.
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
  // The migrator applies entries in this order. If it's out of order, a later one runs first and the schema gets tangled.
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

function snapshotIdxs(): number[] {
  return readdirSync(path.join(drizzleDir, "meta"))
    .filter((f) => /^\d+_snapshot\.json$/.test(f))
    .map((f) => Number(f.split("_")[0]))
    .sort((a, b) => a - b);
}

/**
 * `drizzle-kit generate` produces the diff between the **last snapshot** and the current
 * `schema.ts`. Hand-written SQL doesn't leave a snapshot behind, so as those migrations pile up
 * the snapshot falls behind, and the next `generate` **regenerates changes that were already
 * applied**, in full.
 *
 * Live evidence (2026-09-07): with the snapshot stuck at 0003, running `generate` produced
 * `ALTER TABLE "npcs" DROP COLUMN "openclaw_config";`. 0005 does the same drop, but **first**
 * moves the persona to `agent_config` and backs up the legacy row. The generated version had
 * neither that step nor `IF EXISTS` — applying it without reading it would wipe out the persona.
 *
 * This doesn't forbid writing SQL by hand. It just means **the last migration must always have
 * a matching snapshot**, so `generate` picks up the diff from there.
 */
test("the last migration has a matching snapshot", () => {
  const lastMigration = journalTags().length - 1;
  const snapshots = snapshotIdxs();
  assert.ok(
    snapshots.includes(lastMigration),
    `스냅샷이 뒤처졌습니다(마지막 마이그레이션 idx ${lastMigration}, 스냅샷 ${snapshots.join(",")}). ` +
      "이 상태에서 `drizzle-kit generate` 는 이미 적용된 변경을 다시 만들어 내고, " +
      "거기엔 데이터 이전 단계가 빠진 DROP 이 섞일 수 있습니다.",
  );
});

/**
 * "the last migration has a matching snapshot" only checks that the snapshot *file* exists —
 * `drizzle-kit generate --custom` lets you write the new SQL by hand while it auto-generates
 * only the snapshot, and that snapshot (since custom means it sees no schema change to diff)
 * **just copies the previous snapshot as-is**. So even if you added a new table to the schema
 * and wrote the SQL by hand correctly, generating the snapshot with `--custom` leaves a file
 * whose contents match the old one — anyone who runs `drizzle-kit generate` again from this
 * point mistakes it for an "unapplied change" and emits SQL that recreates a table that already
 * exists. (Live evidence, 2026-09-10: the 0010 snapshot was made this way and was missing the
 * 3 chat_rooms tables.)
 */
test("the latest snapshot's table names match what schema.ts exports", () => {
  const snapshots = snapshotIdxs();
  const lastIdx = snapshots[snapshots.length - 1];
  const padded = String(lastIdx).padStart(4, "0");
  const snapshotPath = path.join(drizzleDir, "meta", `${padded}_snapshot.json`);
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as {
    tables: Record<string, unknown>;
  };
  const snapshotTableNames = Object.keys(snapshot.tables)
    .map((k) => k.replace(/^public\./, ""))
    .sort();

  const schemaTableNames = Object.values(schema)
    .map((t) => getTableName(t as never))
    .sort();

  assert.deepEqual(
    snapshotTableNames,
    schemaTableNames,
    "최신 스냅샷의 테이블 목록이 schema.ts 의 export 와 다릅니다 — " +
      "`drizzle-kit generate --custom` 이 직전 스냅샷을 그대로 복사했을 가능성이 큽니다. " +
      "`drizzle-kit generate`(--custom 없이) 로 스냅샷을 다시 만들고 생성된 SQL 은 버린 뒤 " +
      "손으로 쓴 SQL 을 유지하세요.\n" +
      `  스냅샷: ${JSON.stringify(snapshotTableNames)}\n` +
      `  schema.ts: ${JSON.stringify(schemaTableNames)}`,
  );
});
