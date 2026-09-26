/**
 * Remote (plugin) error codes the hire wizard handles -> i18n keys.
 *
 * This is **separate** from the `ErrorCode`/`ERROR_MESSAGE_KEYS` table in
 * `src/lib/i18n/error-codes.ts`. That table's coverage guard (`error-codes.test.ts`) only
 * scans for a literal `errorCode: "..."` in route source, but the plugin proxy routes
 * (profiles/identity/config) carry `res.failure.code` through as a **dynamic** value, so
 * they escape that guard. In practice, a code like `profile_has_service` fell through
 * `getLocalizedMessage`'s fallback and showed the raw code string on screen (review verdict
 * H). This file plugs that hole in its place — the list lives as a constant in one place,
 * and coverage is pinned by `wizard-error-codes.test.ts` scanning all 4 locales.
 *
 * Code sources: `plugin-errors.ts` (`mapPluginFailure`), `plugin-client.ts` (timeout,
 * unreachable, malformed_response), the proxy route's own `unauthorized`/`forbidden`/
 * `not_found`/`bad_request`/`invalid_profile_name`, `plugin-profile-access.ts`
 * (`no_profile`), `validation.ts` (`unsupported_config_key`).
 *
 * Fix round 2: added `upstream_error` (the fallback for when the upstream `error` is a
 * plain sentence and can't be used as a code) and `gateway_auth_failed` (the real code
 * extracted from an upstream 401's `error` when it's an object) — see
 * `extractCodeAndMessage` in `plugin-errors.ts`.
 *
 * Fix round 3 defect 8: the code the plugin actually emits is not `revision_conflict` but
 * `revision_mismatch` (`deskrpg_plugin/identity.py:142`, observed live by team-lead — this
 * project's spec doc had the wrong code name, and the plugin was implemented to match the
 * doc). Fixing the plugin would break gateways already running the old version, so **both
 * codes are registered** pointing at the same i18n key — covering old and new plugins alike.
 *
 * Final review M-3: `key_missing_after_issue`/`key_store_forbidden` come not from the
 * plugin but from a post-processing failure in the `POST .../plugin/profiles` route itself
 * (missing key value / no storage permission) — this used to be the one spot hardcoding a
 * Korean sentence, breaking the 4-locale discipline.
 */

export const WIZARD_ERROR_CODES = [
  "profile_has_service",
  "revision_conflict",
  // Defect 8: the code the plugin actually emits. Uses the same i18n key as `revision_conflict`.
  "revision_mismatch",
  "already_exists",
  "timeout",
  "unreachable",
  "malformed_response",
  "plugin_error",
  "identity_unreadable",
  "config_unreadable",
  // The code emitted by `mapPluginFailure`'s 200+`unreadable:true` branch (review round 1
  // I-1) — a different path from `identity_unreadable`/`config_unreadable` (409, named codes).
  "unreadable",
  "no_profile",
  "unsupported_config_key",
  "invalid_profile_name",
  "bad_request",
  "forbidden",
  "not_found",
  "unauthorized",
  "upstream_error",
  "gateway_auth_failed",
  // Hermes answered 404 "Unknown or unconfigured profile" — it does not serve this profile.
  "profile_not_found",
  "key_missing_after_issue",
  "key_store_forbidden",
  // Codes emitted by T9/T10 automation (cron/Kanban) routes — `cron-access.ts`/`cron-routes.ts`
  // and the Kanban route carry them as `{code, message}`. The cron/Kanban screens share this one table.
  "plugin_upgrade_required",
  "unknown_cursor",
  "cron_read_only",
  "gateway_not_bound",
  "assignee_not_in_channel",
  "settings_forbidden",
  "attachments_unsupported",
] as const;

export type WizardErrorCode = (typeof WIZARD_ERROR_CODES)[number];

/** Every registered code -> translation key. `wizard-error-codes.test.ts` scans this whole table. */
export const WIZARD_ERROR_MESSAGE_KEYS: Record<WizardErrorCode, string> = {
  profile_has_service: "hermes.wizard.error.profileHasService",
  revision_conflict: "hermes.wizard.error.revisionConflict",
  revision_mismatch: "hermes.wizard.error.revisionConflict",
  already_exists: "hermes.wizard.error.alreadyExists",
  timeout: "hermes.wizard.error.timeout",
  unreachable: "hermes.wizard.error.unreachable",
  malformed_response: "hermes.wizard.error.malformedResponse",
  plugin_error: "hermes.wizard.error.pluginError",
  identity_unreadable: "hermes.wizard.error.identityUnreadable",
  config_unreadable: "hermes.wizard.error.configUnreadable",
  unreadable: "hermes.wizard.error.unreadable",
  no_profile: "hermes.wizard.error.noProfile",
  unsupported_config_key: "hermes.wizard.error.unsupportedConfigKey",
  invalid_profile_name: "hermes.wizard.error.invalidProfileName",
  bad_request: "hermes.wizard.error.badRequest",
  forbidden: "hermes.wizard.error.forbidden",
  not_found: "hermes.wizard.error.notFound",
  unauthorized: "hermes.wizard.error.unauthorized",
  upstream_error: "hermes.wizard.error.upstreamError",
  gateway_auth_failed: "hermes.wizard.error.gatewayAuthFailed",
  profile_not_found: "hermes.wizard.error.profileNotServed",
  key_missing_after_issue: "hermes.wizard.error.keyMissingAfterIssue",
  key_store_forbidden: "hermes.wizard.error.keyStoreForbidden",
  plugin_upgrade_required: "hermes.wizard.error.pluginUpgradeRequired",
  unknown_cursor: "hermes.wizard.error.unknownCursor",
  cron_read_only: "hermes.wizard.error.cronReadOnly",
  gateway_not_bound: "hermes.wizard.error.gatewayNotBound",
  assignee_not_in_channel: "hermes.wizard.error.assigneeNotInChannel",
  settings_forbidden: "hermes.wizard.error.settingsForbidden",
  attachments_unsupported: "hermes.wizard.error.attachmentsUnsupported",
};

const UNKNOWN_KEY = "hermes.wizard.error.unknown";

export function isWizardErrorCode(value: unknown): value is WizardErrorCode {
  return typeof value === "string" && value in WIZARD_ERROR_MESSAGE_KEYS;
}

/** A translation key ready to pass straight to `t()`. An unregistered code collapses to the generic fallback key. */
export function wizardErrorMessageKey(code: string | null | undefined): string {
  return isWizardErrorCode(code) ? WIZARD_ERROR_MESSAGE_KEYS[code] : UNKNOWN_KEY;
}

type Translator = (key: string, params?: Record<string, string | number>) => string;

/** Pulls the screen message directly from a proxy route response (`{errorCode}`). */
export function getWizardErrorMessage(t: Translator, code: string | null | undefined): string {
  return t(wizardErrorMessageKey(code));
}
