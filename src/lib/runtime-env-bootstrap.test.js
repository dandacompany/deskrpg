const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { bootstrapRuntimeEnv, applyEnvText, parseEnvLine } = require("./runtime-env-bootstrap.js");

const PACKAGE_ROOT = path.join(__dirname, "..", "..");

function tmpHome(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `deskrpg-envboot-${label}-`));
}

test("parses KEY=value and ignores comments/blank lines", () => {
  assert.deepEqual(parseEnvLine("FOO=bar"), { key: "FOO", value: "bar" });
  assert.deepEqual(parseEnvLine('QUOTED="hello"'), { key: "QUOTED", value: "hello" });
  assert.equal(parseEnvLine("# FOO=bar"), null);
  assert.equal(parseEnvLine(""), null);
  assert.equal(parseEnvLine("not an assignment"), null);
});

test("an already-set value is not overwritten — a value the user entered themselves wins", () => {
  const env = { KEEP: "user-value" };
  const applied = applyEnvText("KEEP=file-value\nNEW=from-file\n", env);
  assert.equal(env.KEEP, "user-value");
  assert.equal(env.NEW, "from-file");
  assert.deepEqual(applied, ["NEW"]);
});

test("an empty string is treated as 'not set'", () => {
  // A container environment variable can be defined even while empty. Checking only whether it's defined would let an empty value shadow the home file.
  const env = { BLANK: "" };
  applyEnvText("BLANK=from-file\n", env);
  assert.equal(env.BLANK, "from-file");
});

test("generates a JWT_SECRET into the runtime home and loads it into the environment", () => {
  const homeDir = tmpHome("gen");
  try {
    const env = { DESKRPG_HOME: homeDir };
    const result = bootstrapRuntimeEnv({ packageRoot: PACKAGE_ROOT, env, warn() {} });
    assert.ok(result.envPath, "envPath 가 있어야 한다");
    assert.ok(env.JWT_SECRET, "JWT_SECRET 이 채워져야 한다");
    assert.ok(env.JWT_SECRET.length >= 24, `너무 짧다: ${env.JWT_SECRET.length}`);
    // Must also persist in the home file so the next boot uses the same key.
    assert.match(fs.readFileSync(result.envPath, "utf8"), /^JWT_SECRET=.+$/m);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("calling again with the same home keeps the same key — an Update-triggered regeneration doesn't log anyone out", () => {
  const homeDir = tmpHome("stable");
  try {
    const first = { DESKRPG_HOME: homeDir };
    bootstrapRuntimeEnv({ packageRoot: PACKAGE_ROOT, env: first, warn() {} });
    const second = { DESKRPG_HOME: homeDir };
    bootstrapRuntimeEnv({ packageRoot: PACKAGE_ROOT, env: second, warn() {} });
    assert.equal(first.JWT_SECRET, second.JWT_SECRET);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("a user-supplied JWT_SECRET is not overwritten by a generated value", () => {
  const homeDir = tmpHome("user");
  try {
    const env = { DESKRPG_HOME: homeDir, JWT_SECRET: "my-production-key-9f3a2b7c1d4e6f8a" };
    bootstrapRuntimeEnv({ packageRoot: PACKAGE_ROOT, env, warn() {} });
    assert.equal(env.JWT_SECRET, "my-production-key-9f3a2b7c1d4e6f8a");
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("if the runtime-paths module is missing, it quietly moves on — never blocks startup", () => {
  const env = {};
  const result = bootstrapRuntimeEnv({
    packageRoot: path.join(os.tmpdir(), "deskrpg-does-not-exist"),
    env,
    warn() {},
  });
  assert.equal(result.envPath, null);
  assert.deepEqual(result.applied, []);
});

for (const dbType of [undefined, "", "postgresql", "postgres", "sqlite"]) {
  test(`external DATABASE_URL preserves explicit DB_TYPE=${String(dbType)}`, () => {
    const env = { DATABASE_URL: "postgresql://localhost/test", DB_TYPE: dbType };
    applyEnvText("DB_TYPE=sqlite\nSQLITE_PATH=/saved/custom.db\n", env);
    assert.equal(env.DB_TYPE, dbType);
    assert.equal(env.SQLITE_PATH, dbType === "sqlite" ? "/saved/custom.db" : undefined);
  });
}

test("saved SQLite configuration survives bootstrap and a restart", () => {
  const homeDir = tmpHome("sqlite-preserved");
  try {
    const envPath = path.join(homeDir, ".env.local");
    const sqlitePath = path.join(homeDir, "custom.db");
    fs.writeFileSync(sqlitePath, "existing user data");
    fs.writeFileSync(envPath, `DB_TYPE=sqlite\nSQLITE_PATH=${sqlitePath}\n`);
    for (let i = 0; i < 2; i++) {
      const env = { DESKRPG_HOME: homeDir };
      bootstrapRuntimeEnv({ packageRoot: PACKAGE_ROOT, env });
      assert.equal(env.DB_TYPE, "sqlite");
      assert.equal(env.SQLITE_PATH, sqlitePath);
      assert.equal(fs.readFileSync(sqlitePath, "utf8"), "existing user data");
    }
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

for (const text of [
  "DATABASE_URL=postgresql://localhost/saved\nDB_TYPE=sqlite\nSQLITE_PATH=/saved.db\n",
  "DB_TYPE=sqlite\nSQLITE_PATH=/saved.db\nDATABASE_URL=postgresql://localhost/saved\n",
]) {
  test("a saved URL does not override the saved SQLite choice regardless of line order", () => {
    const env = {};
    applyEnvText(text, env);
    assert.equal(env.DB_TYPE, "sqlite");
    assert.equal(env.SQLITE_PATH, "/saved.db");
  });
}

test("PostgreSQL override leaves saved SQLite settings and data untouched", () => {
  const homeDir = tmpHome("override");
  try {
    const envPath = path.join(homeDir, ".env.local");
    const sqlitePath = path.join(homeDir, "custom.db");
    fs.writeFileSync(sqlitePath, "existing data");
    const saved = `DB_TYPE=sqlite\nSQLITE_PATH=${sqlitePath}\nJWT_SECRET=${"a".repeat(48)}\n`;
    fs.writeFileSync(envPath, saved);
    const env = { DESKRPG_HOME: homeDir, DATABASE_URL: "postgresql://localhost/test" };
    bootstrapRuntimeEnv({ packageRoot: PACKAGE_ROOT, env });
    assert.equal(env.DB_TYPE, undefined);
    assert.equal(env.SQLITE_PATH, undefined);
    assert.match(fs.readFileSync(envPath, "utf8"), /DB_TYPE=sqlite/);
    assert.ok(fs.readFileSync(envPath, "utf8").includes(`SQLITE_PATH=${sqlitePath}`));
    assert.equal(fs.readFileSync(sqlitePath, "utf8"), "existing data");
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test(
  "native dotenv syntax survives CLI environment loading",
  { skip: typeof require("node:util").parseEnv !== "function" },
  () => {
    const env = {};
    applyEnvText(
      'PLAIN=value # comment\nQUOTED="value # literal"\nMULTILINE="first\nsecond"\n',
      env,
    );
    assert.deepEqual(env, {
      PLAIN: "value",
      QUOTED: "value # literal",
      MULTILINE: "first\nsecond",
    });
  },
);
