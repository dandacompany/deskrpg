// scripts/setup/setup-lite.js — Zero-dependency SQLite setup (no Docker needed)

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const ENV_FILE = path.join(ROOT, ".env.local");
const ENV_EXAMPLE = path.join(ROOT, ".env.example");

// 1. Create .env.local if missing
if (!fs.existsSync(ENV_FILE)) {
  console.log("[setup] Creating .env.local from .env.example...");
  fs.copyFileSync(ENV_EXAMPLE, ENV_FILE);
}

// 2. Ensure DB_TYPE=sqlite is set
let env = fs.readFileSync(ENV_FILE, "utf8");
if (!env.includes("DB_TYPE=sqlite")) {
  // Comment out DATABASE_URL and enable SQLite
  env = env.replace(/^(DATABASE_URL=.*)$/m, "# $1  # not needed in SQLite mode");
  env += "\nDB_TYPE=sqlite\nSQLITE_PATH=data/deskrpg.db\n";
  fs.writeFileSync(ENV_FILE, env);
  console.log("[setup] Configured SQLite mode in .env.local");
}

// 3. Create data/ directory
const dataDir = path.join(ROOT, "data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
  console.log("[setup] Created data/ directory");
}

// 4. Push schema using SQLite config
console.log("[setup] Applying schema to SQLite...");
try {
  execFileSync("npx", ["drizzle-kit", "push", "--config=drizzle-sqlite.config.ts", "--force"], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, DB_TYPE: "sqlite", SQLITE_PATH: "data/deskrpg.db" },
  });
} catch {
  console.error("[setup] Schema push failed. You may need to run manually:");
  console.error("  npx drizzle-kit push --config=drizzle-sqlite.config.ts --force");
  process.exit(1);
}

console.log("\n✓ Ready (SQLite mode) — run: npm run dev\n");
