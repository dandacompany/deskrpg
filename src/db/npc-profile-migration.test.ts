import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Pool } from "pg";

// Only runs when a scratch PostgreSQL is available. CI uses a docker service; locally, run
// `docker run -d --name deskrpg-migtest -e POSTGRES_PASSWORD=migtest -e POSTGRES_USER=deskrpg -e POSTGRES_DB=deskrpg -p 55437:5432 postgres:16-alpine`.
const URL = process.env.MIGRATION_TEST_DATABASE_URL;

const REPO_ROOT = path.join(__dirname, "..", "..");
const REAL_DRIZZLE_DIR = path.join(REPO_ROOT, "drizzle");
const MIGRATE_JS = path.join(REPO_ROOT, "migrate.js");

/**
 * Makes a copy of the journal in a temp directory so only migrations up through 0007 apply.
 * Never touches the repo's actual drizzle/meta/_journal.json.
 */
function makeTruncatedMigrationsDir(untilTag: string): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "deskrpg-drizzle-"));
  fs.cpSync(REAL_DRIZZLE_DIR, tmpDir, { recursive: true });

  const journalPath = path.join(tmpDir, "meta", "_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  const idx = journal.entries.findIndex((e: { tag: string }) => e.tag === untilTag);
  assert.ok(idx >= 0, `저널에 ${untilTag} 가 있어야 한다`);
  journal.entries = journal.entries.slice(0, idx + 1);
  fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2));

  return tmpDir;
}

test(
  "0008 moves appearance to the profile and backs up then drops unbound NPCs",
  { skip: !URL },
  async (t) => {
    const tmpMigrationsDir = makeTruncatedMigrationsDir("0007_align_snapshot");
    t.after(() => fs.rmSync(tmpMigrationsDir, { recursive: true, force: true }));

    const pool = new Pool({ connectionString: URL });
    // drizzle's migration record lives in a separate "drizzle" schema — dropping public alone
    // leaves the prior run's applied-migrations record intact, so this run wouldn't re-run any migrations.
    await pool.query(
      "DROP SCHEMA public CASCADE; CREATE SCHEMA public; DROP SCHEMA IF EXISTS drizzle CASCADE;",
    );

    // Apply up through 0007 — points at the temp copy, not the repo journal.
    execFileSync("node", [MIGRATE_JS], {
      env: { ...process.env, DATABASE_URL: URL, MIGRATIONS_DIR: tmpMigrationsDir },
      stdio: "pipe",
    });

    // Seed: 1 profile, 2 bound NPCs (different appearances), 1 unbound NPC
    await pool.query(
      // users has no role column — the actual column is system_role, and it's omitted here since it has a default.
      `INSERT INTO users(id, login_id, nickname, password_hash) VALUES ('11111111-1111-1111-1111-111111111111','u','u','x')`,
    );
    await pool.query(
      `INSERT INTO gateway_resources(id, owner_user_id, base_url, token_encrypted, display_name) VALUES ('22222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111','http://x','t','g')`,
    );
    await pool.query(
      `INSERT INTO hermes_profiles(id, gateway_id, profile_name, token_encrypted, display_name) VALUES ('33333333-3333-3333-3333-333333333333','22222222-2222-2222-2222-222222222222','p','t','P')`,
    );
    await pool.query(
      `INSERT INTO channels(id, name, owner_id) VALUES ('44444444-4444-4444-4444-444444444444','c','11111111-1111-1111-1111-111111111111')`,
    );
    await pool.query(`INSERT INTO npcs(id, channel_id, name, position_x, position_y, appearance, hermes_profile_id, updated_at)
    VALUES ('55555555-5555-5555-5555-555555555551','44444444-4444-4444-4444-444444444444','old',1,1,'{"officeLookId":"office-jun","bodyType":"male"}','33333333-3333-3333-3333-333333333333', now() - interval '1 day'),
           ('55555555-5555-5555-5555-555555555552','44444444-4444-4444-4444-444444444444','new',2,2,'{"officeLookId":"office-seo","bodyType":"female"}','33333333-3333-3333-3333-333333333333', now()),
           ('55555555-5555-5555-5555-555555555553','44444444-4444-4444-4444-444444444444','orphan',3,3,'{"officeLookId":"office-tae","bodyType":"male"}',NULL, now())`);

    // Child rows: attach one chat history entry each to the unbound NPC and the duplicate NPC.
    // These get deleted together via CASCADE, so without a backup they'd be permanently lost.
    await pool.query(
      `INSERT INTO characters(id, user_id, name, appearance) VALUES ('66666666-6666-6666-6666-666666666666','11111111-1111-1111-1111-111111111111','ch','{}')`,
    );
    await pool.query(
      `INSERT INTO chat_messages(character_id, npc_id, role, content) VALUES
       ('66666666-6666-6666-6666-666666666666','55555555-5555-5555-5555-555555555553','user','orphan chat'),
       ('66666666-6666-6666-6666-666666666666','55555555-5555-5555-5555-555555555551','user','dup chat')`,
    );

    // Apply up through 0008 — uses the repo's actual drizzle/ as-is.
    execFileSync("node", [MIGRATE_JS], {
      env: { ...process.env, DATABASE_URL: URL },
      stdio: "pipe",
    });

    const {
      rows: [profile],
    } = await pool.query(
      `SELECT appearance FROM hermes_profiles WHERE id='33333333-3333-3333-3333-333333333333'`,
    );
    // The seeded appearance is already a valid office look — 0013's appearance conversion must
    // leave it untouched, so what we read here is exactly what 0008 moved.
    assert.deepEqual(
      profile.appearance,
      { officeLookId: "office-seo", bodyType: "female" },
      "가장 최근 NPC 의 외형이 프로필로 가야 한다",
    );

    const {
      rows: [{ count: orphanCount }],
    } = await pool.query(`SELECT count(*) FROM npcs WHERE hermes_profile_id IS NULL`);
    assert.equal(Number(orphanCount), 0);
    const {
      rows: [{ count: backup }],
    } = await pool.query(`SELECT count(*) FROM npcs_unprofiled_backup`);
    assert.equal(Number(backup), 1, "미연결 NPC 는 지우기 전에 백업된다");

    const {
      rows: [{ count: remaining }],
    } = await pool.query(
      `SELECT count(*) FROM npcs WHERE channel_id='44444444-4444-4444-4444-444444444444'`,
    );
    assert.equal(Number(remaining), 1, "같은 (채널, 프로필) 은 하나만 남는다");
    const {
      rows: [{ count: dup }],
    } = await pool.query(`SELECT count(*) FROM npcs_duplicate_backup`);
    assert.equal(Number(dup), 1);
    const {
      rows: [{ count: conflicts }],
    } = await pool.query(`SELECT count(*) FROM npcs_appearance_conflicts`);
    assert.equal(Number(conflicts), 1, "외형이 갈린 나머지는 conflicts 에 남는다");

    // C1: child rows dropped along via CASCADE must survive in the backup table — unbound(1) + duplicate(1)
    for (const [table, label] of [["npcs_removed_chat_messages_backup", "대화 이력"]] as const) {
      const {
        rows: [{ count: n }],
      } = await pool.query(`SELECT count(*) FROM ${table}`);
      assert.equal(Number(n), 2, `${label} 는 지워지기 전에 ${table} 로 백업된다`);
    }
    for (const table of ["npcs_removed_npc_sessions_backup"]) {
      const {
        rows: [{ count: n }],
      } = await pool.query(`SELECT count(*) FROM ${table}`);
      assert.equal(Number(n), 0, `${table} 는 비어 있어도 존재해야 한다`);
    }

    await pool.end();
  },
);

test(
  "0009 hires the already-bound gateway's profiles into the channel",
  { skip: !URL },
  async (t) => {
    const tmpMigrationsDir = makeTruncatedMigrationsDir("0008_npc_profile_ownership");
    t.after(() => fs.rmSync(tmpMigrationsDir, { recursive: true, force: true }));

    const pool = new Pool({ connectionString: URL });
    await pool.query(
      "DROP SCHEMA public CASCADE; CREATE SCHEMA public; DROP SCHEMA IF EXISTS drizzle CASCADE;",
    );

    // Apply up through 0008
    execFileSync("node", [MIGRATE_JS], {
      env: { ...process.env, DATABASE_URL: URL, MIGRATIONS_DIR: tmpMigrationsDir },
      stdio: "pipe",
    });

    await pool.query(
      `INSERT INTO users(id, login_id, nickname, password_hash) VALUES ('11111111-1111-1111-1111-111111111111','u','u','x')`,
    );
    await pool.query(
      `INSERT INTO gateway_resources(id, owner_user_id, base_url, token_encrypted, display_name) VALUES ('22222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111','http://x','t','g')`,
    );
    await pool.query(
      `INSERT INTO hermes_profiles(id, gateway_id, profile_name, token_encrypted) VALUES
         ('33333333-3333-3333-3333-333333333331','22222222-2222-2222-2222-222222222222','hired','t'),
         ('33333333-3333-3333-3333-333333333332','22222222-2222-2222-2222-222222222222','unhired','t'),
         ('33333333-3333-3333-3333-333333333333','22222222-2222-2222-2222-222222222222','dormant','t')`,
    );
    await pool.query(
      `INSERT INTO channels(id, name, owner_id) VALUES ('44444444-4444-4444-4444-444444444444','c','11111111-1111-1111-1111-111111111111')`,
    );
    await pool.query(
      `INSERT INTO channel_gateway_bindings(channel_id, gateway_id, bound_by_user_id) VALUES ('44444444-4444-4444-4444-444444444444','22222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111')`,
    );
    // One profile that's already hired, and one profile the user put to sleep
    await pool.query(`INSERT INTO npcs(id, channel_id, hermes_profile_id, position_x, position_y, active) VALUES
      ('55555555-5555-5555-5555-555555555551','44444444-4444-4444-4444-444444444444','33333333-3333-3333-3333-333333333331',1,1,true),
      ('55555555-5555-5555-5555-555555555553','44444444-4444-4444-4444-444444444444','33333333-3333-3333-3333-333333333333',3,3,false)`);

    // Apply 0009
    execFileSync("node", [MIGRATE_JS], {
      env: { ...process.env, DATABASE_URL: URL },
      stdio: "pipe",
    });

    const {
      rows: [added],
    } = await pool.query(
      `SELECT active, position_x FROM npcs WHERE hermes_profile_id='33333333-3333-3333-3333-333333333332'`,
    );
    assert.ok(added, "미고용 프로필이 출근부에 나타나야 한다");
    assert.equal(added.active, true);
    assert.equal(added.position_x, null, "자리는 미정으로 만든다");

    const {
      rows: [dormant],
    } = await pool.query(
      `SELECT active FROM npcs WHERE hermes_profile_id='33333333-3333-3333-3333-333333333333'`,
    );
    assert.equal(dormant.active, false, "사용자가 재운 NPC 를 되살리지 않는다");

    await pool.end();
  },
);

test(
  "0010 creates exactly one office room per channel, and doesn't add more when run again",
  { skip: !URL },
  async (t) => {
    const tmpMigrationsDir = makeTruncatedMigrationsDir("0009_npc_backfill_bound_profiles");
    t.after(() => fs.rmSync(tmpMigrationsDir, { recursive: true, force: true }));

    const pool = new Pool({ connectionString: URL });
    await pool.query(
      "DROP SCHEMA public CASCADE; CREATE SCHEMA public; DROP SCHEMA IF EXISTS drizzle CASCADE;",
    );

    // Apply up through 0009 — points at the temp copy, not the repo journal.
    execFileSync("node", [MIGRATE_JS], {
      env: { ...process.env, DATABASE_URL: URL, MIGRATIONS_DIR: tmpMigrationsDir },
      stdio: "pipe",
    });

    await pool.query(
      `INSERT INTO users (id, login_id, nickname, password_hash) VALUES ('11111111-1111-1111-1111-111111111111','u','u','x')`,
    );
    await pool.query(
      `INSERT INTO channels (id, name, owner_id) VALUES ('22222222-2222-2222-2222-222222222222','c','11111111-1111-1111-1111-111111111111')`,
    );

    // Apply 0010 — points at the repo's actual journal (including the migration this test adds).
    execFileSync("node", [MIGRATE_JS], {
      env: { ...process.env, DATABASE_URL: URL },
      stdio: "pipe",
    });

    const { rows } = await pool.query(
      `SELECT kind, name, reply_policy, created_by FROM chat_rooms WHERE channel_id='22222222-2222-2222-2222-222222222222'`,
    );
    assert.deepEqual(rows, [
      {
        kind: "office",
        name: "office",
        reply_policy: "mention",
        created_by: "11111111-1111-1111-1111-111111111111",
      },
    ]);

    // A second office room is blocked by the partial unique index
    await assert.rejects(
      pool.query(
        `INSERT INTO chat_rooms (channel_id, kind, name, reply_policy, created_by) VALUES ('22222222-2222-2222-2222-222222222222','office','office','mention','11111111-1111-1111-1111-111111111111')`,
      ),
    );

    await pool.end();
  },
);
