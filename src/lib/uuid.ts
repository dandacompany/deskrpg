const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether a client-supplied value is a canonical uuid. Row ids are uuids, and PostgreSQL throws
 * on a malformed one where SQLite just finds nothing — check before the value reaches a query.
 */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}
