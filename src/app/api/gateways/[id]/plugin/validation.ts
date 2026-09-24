/**
 * Pure validation functions for the plugin proxy routes (profiles/identity/config).
 *
 * Follows the convention of `src/app/api/gateways/[id]/profiles/validation.ts` — validation is pulled
 * out of the handlers so it can be pinned without starting a route.
 */

import { isCreatableProfileName } from "@/lib/hermes/creatable-profile-name";
import type { CloneKeyScope } from "@/lib/hermes/plugin-client-types";

export type CreatableNameValidation =
  { ok: true; name: string } | { ok: false; errorCode: "invalid_profile_name" };

/**
 * Validates only profile names **to be newly created**. Uses `isCreatableProfileName` —
 * not `PROFILE_NAME_RE` (for registering existing profiles, lenient). Hermes actually enforces
 * `^[a-z0-9][a-z0-9_-]{0,63}$` and rejects reserved words on creation (measured on a live
 * gateway). Without blocking here the remote gives 400 and the reason never reaches the screen.
 */
export function validateCreatableProfileName(input: unknown): CreatableNameValidation {
  const name =
    typeof (input as { name?: unknown })?.name === "string"
      ? (input as { name: string }).name.trim()
      : "";
  if (!isCreatableProfileName(name)) {
    return { ok: false, errorCode: "invalid_profile_name" };
  }
  return { ok: true, name };
}

export type IdentityPutValidation =
  { ok: true; body: string; ifRevision: string } | { ok: false; errorCode: "bad_request" };

/** Without `ifRevision` optimistic locking disappears entirely — block it here. */
export function validateIdentityPutBody(input: unknown): IdentityPutValidation {
  const record =
    typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const body = record.body;
  const ifRevision = record.ifRevision;
  if (typeof body !== "string" || typeof ifRevision !== "string" || !ifRevision) {
    return { ok: false, errorCode: "bad_request" };
  }
  return { ok: true, body, ifRevision };
}

const ALLOWED_CONFIG_KEYS = new Set([
  "model",
  "provider",
  "toolsets",
  "reasoning_effort",
  "enabledToolsets",
  "disabledSkills",
]);

export type ConfigPutValidation =
  | { ok: true; patch: Record<string, unknown> }
  | { ok: false; errorCode: "bad_request" }
  | { ok: false; errorCode: "unsupported_config_key"; unknownKeys: string[] };

/**
 * Passes only the six keys the plugin allows (`model`/`provider`/`toolsets`/`reasoning_effort`/
 * `enabledToolsets`/`disabledSkills`). If the screen
 * accidentally sends another key the remote gives 400; blocking it here makes it clear
 * why it was blocked.
 */
export function validateConfigPatch(input: unknown): ConfigPutValidation {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, errorCode: "bad_request" };
  }
  const patch = input as Record<string, unknown>;
  const unknownKeys = Object.keys(patch).filter((k) => !ALLOWED_CONFIG_KEYS.has(k));
  if (unknownKeys.length > 0) {
    return { ok: false, errorCode: "unsupported_config_key", unknownKeys };
  }
  return { ok: true, patch };
}

export type CreateOptionsValidation =
  | { ok: true; cloneFrom?: "default"; cloneKeys?: CloneKeyScope }
  | { ok: false; errorCode: "bad_request" };

const CLONE_KEY_SCOPES: readonly CloneKeyScope[] = ["referenced", "api_keys"];

/**
 * The only clone source for now is `default` — make the reason clear here before the plugin gives 400.
 * `cloneKeys` (key clone scope) only together with `cloneFrom`, and one of `referenced` or `api_keys`.
 */
export function validateCreateOptions(input: unknown): CreateOptionsValidation {
  const record = (input ?? {}) as { cloneFrom?: unknown; cloneKeys?: unknown };
  const raw = record.cloneFrom;
  const keys = record.cloneKeys;
  const hasKeys = keys !== undefined && keys !== null;
  if (raw === undefined || raw === null) {
    return hasKeys ? { ok: false, errorCode: "bad_request" } : { ok: true };
  }
  if (raw !== "default") return { ok: false, errorCode: "bad_request" };
  if (!hasKeys) return { ok: true, cloneFrom: "default" };
  if (!CLONE_KEY_SCOPES.includes(keys as CloneKeyScope)) {
    return { ok: false, errorCode: "bad_request" };
  }
  return { ok: true, cloneFrom: "default", cloneKeys: keys as CloneKeyScope };
}
