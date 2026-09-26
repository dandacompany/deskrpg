/**
 * Turns plugin responses into failure descriptions the screen can use.
 *
 * The plugin is built to report failures **honestly** (an unreadable file is
 * `unreadable: true` / 409 rather than 500; a delete refusal includes the reason and a shell command).
 * If the screen flattens that into "오류가 발생했습니다", the whole design becomes meaningless.
 *
 * When `blocksEditor` is true, the editor is **not opened** — opening an empty editor would let
 * the user erase a human-written identity with a single click of the save button.
 *
 * Review round 1 I-2: structured fields other than `error`/`reason` (`currentRevision` for re-reading,
 * `name` of a name conflict, `unit` of a delete refusal, etc.) were being thrown away entirely. Moving them
 * into `details` as-is lets the screen build concrete sentences like "the name 'noah' already exists".
 *
 * Fix round 2 — live measurement (team-lead, MiniPC gateway, Hermes v0.21.0): the `error`
 * field comes in three different shapes.
 *
 *     404  { "error": "Unknown or unconfigured profile" }         — plain sentence
 *     401  { "error": { "message": "...", "type": "gateway_auth_error",
 *                       "code": "gateway_auth_failed" } }         — object, real code inside
 *     409  { "error": "config_unreadable", "reason": "..." }      — short code (original assumption)
 *
 * `typeof record.error === "string" ? record.error : "plugin_error"` alone can't handle all three
 * shapes — the sentence flows straight into the `code` slot (a value missing from the code dictionary in
 * `wizard-error-codes.ts`, whose wording changes with the Hermes version), and the object
 * gets folded into `plugin_error`, losing the real code inside (`gateway_auth_failed`). `extractCodeAndMessage`
 * handles each of the three shapes: a code-like string stays as the code, an object has its inner `code`/`message`
 * extracted, and anything else (a sentence) has its code folded into `upstream_error` while **the sentence itself
 * is preserved in `message`** — deciding whether something looks like a code is a heuristic and can be wrong at
 * the edges, but that beats the current state where a sentence reliably lands in the code slot.
 */

export type PluginFailure = {
  code: string;
  message: string;
  /** Is this a state where the editor must not open (risk of overwriting the original with an empty screen) */
  blocksEditor: boolean;
  /** Command the user must run in a shell. null if none */
  showsShellCommand: string | null;
  /** Remaining body fields other than `error`/`reason` (currentRevision, name, unit, etc.). Empty object if none */
  details: Record<string, unknown>;
};

/** Codes meaning the file can't be parsed — all of them block the editor. */
const UNREADABLE_CODES = new Set(["identity_unreadable", "config_unreadable"]);

/**
 * Whitelist of codes whose shell command may be shown on screen as-is (M-3).
 *
 * Previously, any `message` ending in the form `: hermes ...` was extracted regardless of code.
 * If an explanation for another code such as `revision_conflict` happened to end in the same shape, an unrelated
 * command button appeared — narrowed to only `profile_has_service`, which actually requires shell cleanup.
 */
const SHELL_COMMAND_CODES = new Set(["profile_has_service"]);

function asRecord(body: unknown): Record<string, unknown> {
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
}

function extractShellCommand(reason: string): string | null {
  // The plugin provides it in the form `... 셸에서 정리하세요: hermes profile delete noah`.
  const match = /:\s*(hermes\s+[^\n]+?)\s*$/.exec(reason);
  return match ? match[1] : null;
}

/** Moves everything in `record` except `error`/`reason` (and `unreadable`) into `details`. */
function extractDetails(record: Record<string, unknown>, omit: string[]): Record<string, unknown> {
  const details: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!omit.includes(key)) details[key] = value;
  }
  return details;
}

/**
 * Considered "code-like" if it starts with a lowercase letter, consists only of letters, digits, underscores
 * and hyphens, and contains **at least one underscore or hyphen**.
 *
 * Fix round 3 I-4 (reviewer evidence): the old regex (`i` flag + no separator requirement) mistook
 * one-word sentences starting with an uppercase letter and single lowercase words without `_`/`-` for codes —
 * and since `message` was then `reason` (usually an empty string), **the sentence vanished entirely** (worse than
 * the plain-sentence case). Evidence table:
 *
 *     config_unreadable / already_exists / profile_has_service / gateway_auth_failed
 *       → true (code, as intended)
 *     Unknown or unconfigured profile
 *       → false (has spaces, sentence kept as-is)
 *     Unauthorized / Forbidden / conflict / error / failed
 *       → before: true (misjudged) → now: false (uppercase start is blocked by removing `i`, and a
 *         single lowercase word without a separator by requiring `_`/`-`)
 *     Not Found / Bad Request / internal server error
 *       → false (has spaces, safe even before)
 *
 * `no_profile`/`unsupported_config_key`/`invalid_profile_name`/`bad_request`/
 * `forbidden`/`not_found`/`unauthorized` (all **literal** values coming from the proxy route's own
 * validation/authorization failures and don't go through this function) are values that never actually arrive
 * as `record.error` — likewise, registered codes without underscores/hyphens such as `timeout`/`unreachable`/
 * `unreadable`/`forbidden`/`unauthorized` are hardcoded failure objects in `plugin-client.ts` or our own route
 * literals, so they don't go through this regex — every code that actually arrives as a `record.error` string is
 * snake_case with an underscore (evidence table above).
 */
const CODE_LIKE_RE = /^[a-z][a-z0-9_-]*$/;

function isCodeLikeString(value: string): boolean {
  return CODE_LIKE_RE.test(value) && (value.includes("_") || value.includes("-"));
}

/**
 * Splits the three shapes of `record.error` (string-code / string-sentence / object) and folds them into
 * `{code, message}`. See the live measurement in the module comment.
 *
 * I-4: whether or not it's judged a code, `message` always holds the original text (`reason || errorField`).
 * Previously, a string misjudged as a code had only `reason` (usually `""`) as its `message`, so a misjudgment
 * lost both the code slot (unregistered value → "unknown error" on screen) and the sentence slot.
 */
function extractCodeAndMessage(record: Record<string, unknown>): { code: string; message: string } {
  const errorField = record.error;
  // Native plugin RequestError uses detail; older profile handlers use reason.
  const reason =
    (typeof record.reason === "string" && record.reason) ||
    (typeof record.detail === "string" ? record.detail : "");

  if (errorField && typeof errorField === "object" && !Array.isArray(errorField)) {
    // 401 gateway_auth_error shape — the real code is inside. If absent, lump it together.
    const nested = errorField as Record<string, unknown>;
    const nestedCode = typeof nested.code === "string" ? nested.code : "plugin_error";
    const nestedMessage = typeof nested.message === "string" ? nested.message : reason;
    return { code: nestedCode, message: nestedMessage };
  }

  if (typeof errorField === "string") {
    const message = reason || errorField;
    if (isCodeLikeString(errorField)) return { code: errorField, message };
    // A plain sentence (or a single word without a separator) — don't put it in the code slot. Keep the
    // sentence in message instead of losing it.
    return { code: "upstream_error", message };
  }

  return { code: "plugin_error", message: reason };
}

/** Hermes' answer for `/p/<name>/…` when it does not serve that profile (live, 2026-09-26). */
const UNKNOWN_PROFILE_RE = /unknown or unconfigured profile/i;

/**
 * A generic code (the body was a plain sentence or empty) still says something through its status:
 * 401/403 is the gateway refusing the key, and Hermes' 404 sentence for an unserved profile names
 * the profile as the cause — the same `profile_not_found` the profile proxy routes use. The employee editor shows these instead of "the gateway reported an error".
 */
function refineGenericCode(code: string, status: number, message: string): string {
  if (code !== "upstream_error" && code !== "plugin_error") return code;
  if (status === 401 || status === 403) return "gateway_auth_failed";
  if (status === 404 && UNKNOWN_PROFILE_RE.test(message)) return "profile_not_found";
  return code;
}

export function mapPluginFailure(input: { status: number; body: unknown }): PluginFailure | null {
  const record = asRecord(input.body);

  if (input.status >= 200 && input.status < 300) {
    // The only case that is a failure despite 200 — the file couldn't be read.
    if (record.unreadable === true) {
      return {
        code: "unreadable",
        message: typeof record.reason === "string" ? record.reason : "",
        blocksEditor: true,
        showsShellCommand: null,
        details: extractDetails(record, ["reason", "unreadable"]),
      };
    }
    return null;
  }

  const { code: extracted, message } = extractCodeAndMessage(record);
  const code = refineGenericCode(extracted, input.status, message);
  const showsShellCommand =
    message && SHELL_COMMAND_CODES.has(code) ? extractShellCommand(message) : null;

  return {
    code,
    message,
    // M-4: like unreachable (client layer), 5xx means "the server couldn't give a response", so it is
    // treated like the named unreadable code — opening it would just fail again at save time.
    blocksEditor: UNREADABLE_CODES.has(code) || input.status >= 500,
    showsShellCommand,
    details: extractDetails(record, ["error", "reason"]),
  };
}

/**
 * Turns a result rejected by the automation contract gate (`meetsAutomationContract`) into the same failure shape.
 *
 * The gateway was reached and the plugin exists, but **the version or capabilities fall short** —
 * what the user must do is upgrade the plugin, not retry, so it must not be mixed with
 * `unreachable`/`plugin_absent`. `details` carries the minimum version, reason and missing capability so the
 * screen can build a sentence like "plugin 0.6.0 or later is required (no events)".
 */
export function pluginUpgradeRequired(gate: {
  ok: false;
  minVersion: string;
  reason: string;
  missing?: string[];
}): PluginFailure {
  return {
    code: "plugin_upgrade_required",
    message: "",
    blocksEditor: true,
    showsShellCommand: null,
    details: {
      minVersion: gate.minVersion,
      reason: gate.reason,
      ...(gate.missing ? { missing: gate.missing } : {}),
    },
  };
}
