/**
 * Step composition and transitions for the hire wizard.
 *
 * Depending on capability, **the feature visibly shrinks instead of silently breaking.**
 * A locked step doesn't disappear — it stays with a reason. If it disappeared the user
 * wouldn't even know the feature exists; staying grayed out shows what unlocks it.
 */

import type { PluginStatus } from "@/lib/hermes/plugin-capability";

export type WizardStep = "profile" | "identity" | "appearance" | "config";

export type StepAvailability = {
  step: WizardStep;
  enabled: boolean;
  /** i18n key for the locked reason. null when open. */
  lockedReason: string | null;
};

/**
 * 1 profile -> 2 identity -> 3 appearance -> 4 AI model. That's where it ends.
 *
 * The old step 4 (seat placement) had degenerated into a step with nothing left but a link
 * button — the map owns placement now. Appearance is auto-assigned one on registration and
 * changed in step 3.
 */
const ORDER: WizardStep[] = ["profile", "identity", "appearance", "config"];

export function availableSteps(
  status: PluginStatus,
  localDiscovery: boolean,
  /** Whether the profile this wizard is working with already exists (just created, or entered with an existing profile). */
  hasProfile: boolean,
): StepAvailability[] {
  const pluginOk = status === "plugin_ready";

  // What the user needs to do is the opposite for 401 vs. 404 — replace the key vs. install the plugin.
  const blockedReason =
    status === "plugin_unauthorized"
      ? "hermes.plugin.locked.unauthorized"
      : status === "plugin_absent"
        ? "hermes.plugin.locked.absent"
        : "hermes.plugin.locked.unknown";

  return ORDER.map((step) => {
    if (step === "profile") {
      // A profile can be found and registered via local filesystem discovery even without a plugin.
      const enabled = pluginOk || localDiscovery;
      return { step, enabled, lockedReason: enabled ? null : blockedReason };
    }
    if (step === "appearance") {
      // Appearance is stored by DeskRPG — independent of the plugin, it only needs a profile to work with.
      return hasProfile
        ? { step, enabled: true, lockedReason: null }
        : { step, enabled: false, lockedReason: "hermes.wizard.locked.needsProfile" };
    }
    // Identity/AI model have no way to be reached remotely without a plugin.
    if (!pluginOk) return { step, enabled: false, lockedReason: blockedReason };
    // With no profile there's nothing to read. This step used to stay open, so an empty
    // lookup result showed "can't read the identity file" and free-text input appeared
    // instead of the model list (2026-09-18).
    if (!hasProfile)
      return { step, enabled: false, lockedReason: "hermes.wizard.locked.needsProfile" };
    return { step, enabled: true, lockedReason: null };
  });
}

export function identityDecision(payload: {
  isDefaultTemplate?: boolean | null;
  unreadable?: boolean;
}): "edit_fresh" | "ask_overwrite" | "blocked" {
  if (payload.unreadable) return "blocked";
  // **Blocks anything that isn't a boolean.** This used to filter only `=== null`, but when
  // the field was **entirely missing** from the payload (`{}`), `undefined` flowed through
  // as falsy and became `ask_overwrite` — i.e. "there is no identity" got inverted into
  // "an identity exists, overwrite it?" This actually reproduced in staging (2026-09-02):
  // the plugin honestly returned `isDefaultTemplate: true`, but the screen asked to overwrite.
  //
  // Since the type is `boolean | null`, TypeScript guards against a missing field, but that
  // protection disappears the moment the response is cast `as IdentityPayload`. That's why
  // it needs to be checked again at runtime.
  //
  // When unsure, blocking is the safe side — opening an empty editor or offering to
  // overwrite can lose a human-written identity with a single save.
  if (typeof payload.isDefaultTemplate !== "boolean") return "blocked";
  return payload.isDefaultTemplate ? "edit_fresh" : "ask_overwrite";
}

export type ServingVerdict = "served" | "key_rejected" | "not_served" | "unknown";

/**
 * Whether the profile created in step 1 is actually served — decided from the result of a
 * single live `GET .../identity` call (verdict I; the `served_profiles` snapshot is not used).
 *
 * Fix round 1: the proxy route always translates an upstream failure into HTTP 200 +
 * `errorCode` (an extension of the problem where Cloudflare replaces the origin's 5xx body —
 * see the `proxyInit` comment in `route.ts`) — in that process the original upstream status
 * code (`PluginResponse.status`) is lost along with it, so a 401 and a 404 with no structured
 * `error` field both collapsed into `plugin_error`, and the "401 and 404 need opposite user
 * actions" principle broke down again at this layer. The 4 proxy routes now also carry
 * `upstreamStatus` — this is where that value distinguishes 401 (key problem) from 404
 * (this profile isn't served, per the allowlist).
 */
export function classifyServingCheck(input: {
  errorCode: string | null;
  upstreamStatus: number | null;
}): ServingVerdict {
  if (!input.errorCode) return "served";
  if (input.upstreamStatus === 401) return "key_rejected";
  if (input.upstreamStatus === 404) return "not_served";
  return "unknown";
}

export function nextStep(current: WizardStep, steps: StepAvailability[]): WizardStep | null {
  const idx = ORDER.indexOf(current);
  for (let i = idx + 1; i < ORDER.length; i += 1) {
    const candidate = steps.find((s) => s.step === ORDER[i]);
    if (candidate?.enabled) return candidate.step;
  }
  return null;
}

/** The nearest preceding **open** step. null if none — "previous" never appears on the first step. */
export function previousStep(current: WizardStep, steps: StepAvailability[]): WizardStep | null {
  const idx = ORDER.indexOf(current);
  for (let i = idx - 1; i >= 0; i -= 1) {
    const candidate = steps.find((s) => s.step === ORDER[i]);
    if (candidate?.enabled) return candidate.step;
  }
  return null;
}
/** The reason, if the next step is locked — becomes the "Next" button's tooltip. */
export function nextLockedReason(current: WizardStep, steps: StepAvailability[]): string | null {
  const idx = ORDER.indexOf(current);
  const candidate = steps.find((s) => s.step === ORDER[idx + 1]);
  return candidate && !candidate.enabled ? (candidate.lockedReason ?? null) : null;
}
