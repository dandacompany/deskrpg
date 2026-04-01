import { db, isPostgres } from "@/db";
import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";

const startTime = Date.now();
type SqliteHealthDb = { get: (query: ReturnType<typeof sql.raw>) => unknown };

export async function GET() {
  try {
    if (isPostgres) {
      await db.execute(sql`SELECT 1`);
    } else {
      (db as unknown as SqliteHealthDb).get(sql.raw("SELECT 1"));
    }

    return NextResponse.json({
      status: "ok",
      db: "connected",
      uptime: Math.floor((Date.now() - startTime) / 1000),
    });
  } catch (error) {
    console.error("[api/health] database probe failed", error);
    return NextResponse.json(
      { status: "error", db: "disconnected" },
      { status: 503 }
    );
  }
}
