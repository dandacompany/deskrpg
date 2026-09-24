/**
 * Is this a unique constraint violation?
 *
 * PostgreSQL throws SQLSTATE 23505, while better-sqlite3 throws
 * `SQLITE_CONSTRAINT_UNIQUE` (or `_PRIMARYKEY`). **Both** must be checked — because only the
 * pg code was checked, a SQLite deployment once returned 500 instead of 409 for a duplicate,
 * and the client branch waiting for that 409 never ran a single time.
 */
export function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  return (
    code === "23505" ||
    code === "SQLITE_CONSTRAINT_UNIQUE" ||
    code === "SQLITE_CONSTRAINT_PRIMARYKEY"
  );
}
