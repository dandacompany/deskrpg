// GET /api/admin/diagnostics — what `deskrpg doctor` shows, viewed in the browser. system_admin only.
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db, gatewayResources, getDefaultSqlitePath, users } from "@/db";
import { hermesInstallAllowed, hostSetupAllowed } from "@/lib/hermes/setup/policy";
import { readLocaleCookie } from "@/lib/i18n/server";
import { getUserId } from "@/lib/internal-rpc";
import startupCheck from "@/lib/startup-check.js";

export type DiagnosticsGateway = {
  id: string;
  label: string;
  pluginStatus: string;
  checkedAt: string | null;
};

export type DiagnosticsReport = {
  environment: { errors: string[]; warnings: string[]; dbTarget: "postgresql" | "sqlite" };
  database: { ok: boolean; target: string; message: string };
  hostSetup: { wizard: boolean; hermesInstall: boolean };
  gateways: DiagnosticsGateway[];
};

/**
 * Non-admins get 404, not 403 — we do not reveal that this screen exists at all.
 * Unauthenticated requests get the same 404 (a 401 would say "log in and there is something here").
 */
const notFound = () =>
  NextResponse.json({ errorCode: "not_found", error: "not found" }, { status: 404 });

function toIso(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  // The SQLite runtime returns timestamps as TEXT — if parsing fails, keep the original text.
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
  }
  return null;
}

/**
 * Gateway summary. **No token or base URL** — diagnostics need only the plugin verdict and
 * when that verdict was made, and credentials never leave the server.
 */
async function readGateways(): Promise<DiagnosticsGateway[]> {
  try {
    const rows = await db
      .select({
        id: gatewayResources.id,
        displayName: gatewayResources.displayName,
        pluginStatus: gatewayResources.pluginStatus,
        pluginCheckedAt: gatewayResources.pluginCheckedAt,
      })
      .from(gatewayResources);
    return rows.map((row) => ({
      id: row.id,
      label: row.displayName,
      pluginStatus: row.pluginStatus || "unknown",
      checkedAt: toIso(row.pluginCheckedAt),
    }));
  } catch {
    // Return diagnostics even when the DB is down — database.ok states that fact.
    return [];
  }
}

export async function GET(req: NextRequest) {
  const userId = getUserId(req);
  if (!userId) return notFound();

  // The role check goes through the DB, so if the DB is completely down even admins get 404. We still choose
  // fail-closed — better than handing host state to an unverified request.
  let systemRole: string | undefined;
  try {
    const [row] = await db
      .select({ systemRole: users.systemRole })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    systemRole = row?.systemRole ?? undefined;
  } catch {
    return notFound();
  }
  if (systemRole !== "system_admin") return notFound();

  // startup-check picks its language from the locale variables. Korean viewers get Korean, everyone else English
  // (the CLI only has those two). Only a copy is changed — process.env stays as it is.
  const viewerEnv = {
    ...process.env,
    LC_ALL: readLocaleCookie(req.headers.get("cookie")) === "ko" ? "ko_KR.UTF-8" : "C",
  };
  const inspected = startupCheck.inspectEnvironment(viewerEnv);
  // startup-check.js is CommonJS, so dbTarget is inferred as string — narrow it here with the same
  // rule that file uses (only one of the two comes out).
  const dbTarget: "postgresql" | "sqlite" =
    inspected.dbTarget === "postgresql" ? "postgresql" : "sqlite";
  const environment = { errors: inspected.errors, warnings: inspected.warnings, dbTarget };
  // Called with the same arguments as server.js — probes the DB the app actually uses.
  const database = await startupCheck.checkDatabaseReachable({
    databaseUrl: process.env.DATABASE_URL,
    sqlitePath: getDefaultSqlitePath(),
    target: dbTarget,
    env: viewerEnv,
  });

  const report: DiagnosticsReport = {
    environment,
    database,
    hostSetup: {
      wizard: hostSetupAllowed(process.env, "system_admin"),
      hermesInstall: hermesInstallAllowed(process.env, "system_admin", "local"),
    },
    gateways: await readGateways(),
  };
  return NextResponse.json(report);
}
