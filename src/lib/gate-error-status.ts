/**
 * The HTTP status each gate failure code is sent with — one table instead of literals scattered
 * over the access and route files.
 *
 * The screen's classifier (`gate-failure.ts`) branches on `code` alone, so a route that sent
 * `plugin_absent` as 503 would still be classified as "install the plugin" while every proxy and
 * log in between saw a different failure. Server call sites build these responses with
 * `gateError` (`cron-access.ts`), and `gate-error-status.test.ts` scans the source for any literal
 * pair that disagrees with this table.
 *
 * Pure data — safe for the client bundle.
 */
export const GATE_ERROR_STATUS = {
  gateway_not_bound: 409,
  plugin_absent: 404,
  plugin_unauthorized: 401,
  plugin_upgrade_required: 428,
  plugin_unknown: 503,
  unreachable: 503,
  timeout: 504,
} as const;

export type GateErrorCode = keyof typeof GATE_ERROR_STATUS;

function isGateErrorCode(code: string): code is GateErrorCode {
  return Object.prototype.hasOwnProperty.call(GATE_ERROR_STATUS, code);
}

/** `cronError(<status>, "<code>"` with any whitespace between — the literal shape routes use. */
const LITERAL_PAIR = /\bcronError\(\s*(\d{3})\s*,\s*"([a-z_]+)"/g;

/** Literal status/code pairs in `source` whose code is a gate code sent with the wrong status. */
export function findGateStatusMismatches(
  source: string,
): { code: GateErrorCode; status: number; expected: number }[] {
  const out: { code: GateErrorCode; status: number; expected: number }[] = [];
  for (const match of source.matchAll(LITERAL_PAIR)) {
    const status = Number(match[1]);
    const code = match[2];
    if (!isGateErrorCode(code)) continue;
    const expected = GATE_ERROR_STATUS[code];
    if (status !== expected) out.push({ code, status, expected });
  }
  return out;
}
