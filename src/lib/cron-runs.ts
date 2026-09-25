import type { CronRun } from "@/lib/hermes/deskrpg-plugin-types";

/**
 * One run-history row in the shape the screen reads (`CronRun`, times as ISO strings).
 *
 * The plugin builds these rows from Hermes' session table, whose `started_at`/`ended_at` are REAL
 * epoch seconds, and passes them through — so the times arrived as numbers and every row showed "—".
 * Numbers (and numeric strings) are read as epoch seconds, or milliseconds when they are too large to
 * be seconds; ISO strings pass as they are. Anything unreadable becomes empty instead of throwing.
 */
export function normalizeCronRun(raw: unknown): CronRun {
  const row = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    id: String(row.id ?? ""),
    started_at: isoTime(row.started_at) ?? "",
    ended_at: isoTime(row.ended_at),
    status: typeof row.status === "string" && row.status ? row.status : "unknown",
    summary: typeof row.summary === "string" ? row.summary : "",
    result_text: typeof row.result_text === "string" ? row.result_text : "",
  };
}

/** Epoch values above this are milliseconds (year 5138 in seconds). */
const MILLISECONDS_FROM = 1e11;

function isoTime(value: unknown): string | null {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+(\.\d+)?$/.test(value.trim())
        ? Number(value)
        : null;
  if (numeric !== null) {
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    return new Date(numeric >= MILLISECONDS_FROM ? numeric : numeric * 1000).toISOString();
  }
  if (typeof value === "string" && value && !Number.isNaN(Date.parse(value))) return value;
  return null;
}
