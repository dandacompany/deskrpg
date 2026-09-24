// migrate.js — Runs Drizzle PostgreSQL migrations generated from schema.ts

"use strict";

const path = require("node:path");
const { Pool } = require("pg");
const { drizzle } = require("drizzle-orm/node-postgres");
const { migrate } = require("drizzle-orm/node-postgres/migrator");

const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR || path.join(__dirname, "drizzle");

async function runMigrations() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.log("[migrate] No DATABASE_URL — skipping migrations.");
    return;
  }

  const pool = new Pool({ connectionString: databaseUrl });
  // Conversion counts that migrations emit via RAISE NOTICE are silently dropped without a listener.
  pool.on("connect", (client) => client.on("notice", (n) => console.log("[migrate]", n.message)));

  try {
    const db = drizzle(pool);
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
    console.log("[migrate] Drizzle migrations applied successfully.");
  } finally {
    await pool.end();
  }
}

runMigrations().catch((err) => {
  console.error("[migrate] Fatal error:", err);
  process.exit(1);
});
