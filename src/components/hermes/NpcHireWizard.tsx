"use client";

/**
 * NPC hire wizard — 1 profile, 2 identity, 3 appearance, 4 AI model. Ends at step 4.
 *
 * Steps visibly shrink depending on capability (`availableSteps`) — a locked step still
 * stays grayed out with a reason shown, never hidden. Steps 2/3 stay locked until there's
 * a profile to work with.
 *
 * The old step 4 (placement) was removed. It had degenerated into a step with nothing left
 * but link buttons ("Choose a finished appearance," "Go to channel," "Close wizard").
 * Appearance is auto-assigned on registration (`registerHermesProfile`) and changed from
 * employee detail. The map owns placement.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";

import { useT } from "@/lib/i18n";
import { getLocalizedErrorMessage, withHeaderErrorCode } from "@/lib/i18n/error-codes";
import { isCreatableProfileName } from "@/lib/hermes/creatable-profile-name";
import { profileLoginUrl } from "@/lib/hermes/dashboard-link";
import type { PluginStatus } from "@/lib/hermes/plugin-capability";
import type { CatalogPayload } from "@/lib/hermes/plugin-client-types";
import type { WorkerPluginCreateResult } from "@/lib/hermes/deskrpg-plugin-types";

import {
  availableSteps,
  classifyServingCheck,
  identityDecision,
  nextStep,
  type StepAvailability,
  type WizardStep,
  previousStep,
  nextLockedReason,
} from "./hire-wizard-steps";
import ProfileAppearanceEditor from "./ProfileAppearanceEditor";
import ProviderAuthPanel from "./ProviderAuthPanel";
import ToolsetSkillPicker from "./ToolsetSkillPicker";
import { getWizardErrorMessage } from "./wizard-error-codes";
import type { CharacterAppearance } from "@/game/three/office-appearance";

// ---------------------------------------------------------------------------
// Types mirroring the proxy routes' response shapes (Task 5·6·7)
// ---------------------------------------------------------------------------

type ProvisionedProfile = {
  name: string;
  /**
   * The **number of channels this profile actually attends**. Attendance only happens on
   * channels the gateway is already attached to, so if it's 0, the result line in step 3
   * must not say "attended." An existing profile continued from editing (`resumed`) has no
   * way to know this, so it's `undefined`.
   */
  attendedChannels?: number;
  keyIssued: boolean;
  keyError?: string;
  keyStored: boolean;
  keyStoredError?: string;
  /** Cloning the default profile failed (the profile itself was created). Only present when cloning was requested. */
  cloneError?: string;
  /** The **names** of the config/keys inherited via cloning. Values are never sent. */
  cloned?: { configKeys?: string[]; envKeys?: string[] };
  /**
   * Plugin 0.16.0 — the result of placing the worker plugin in this employee's home. If the
   * gateway's worker propagation is off, it's `{skipped: "propagation_disabled"}`, and that
   * employee's Kanban/cron output won't collect. Absent on an old plugin.
   */
  workerPlugin?: WorkerPluginCreateResult;
};

type IdentityPayload = {
  body: string | null;
  isDefaultTemplate: boolean | null;
  revision: string | null;
  unreadable?: boolean;
};

type ProxyFailure = {
  errorCode?: string;
  error?: string;
  shellCommand?: string | null;
  upstreamStatus?: number | null;
};

interface NpcHireWizardProps {
  gatewayId: string;
  pluginStatus: PluginStatus;
  localDiscovery: boolean;
  /**
   * Profile names **already registered** on this gateway.
   *
   * Without this, the wizard could only carry steps 2/3 forward for "the profile just
   * created" — closing partway through would leave no way back (observed in staging
   * 2026-09-03: created `oliver`, closed, and had no way to edit the identity). Fixing an
   * existing profile's identity/config later is also a legitimate use of the wizard — the
   * spec just missed this entry point.
   */
  existingProfiles: string[];
  /**
   * Starts **directly at step 2 identity** with this profile. Used by the "Personality"
   * button in the profile list — reopening the wizard and making the user pick again at
   * step 1 means nobody finds the feature even though it exists (a user in staging actually
   * said "there seems to be no way to edit the identity").
   */
  initialProfile?: string | null;
  /**
   * The gateway's public Hermes dashboard URL (plugin `dashboard_url`, sent only to the
   * owner). Used to build the "log in as this employee" link in step 3 config. Without it,
   * only guidance text is shown.
   */
  dashboardUrl?: string | null;
  /**
   * The screen title. When this wizard is used as an **editor** from employee detail, the
   * title "Hire wizard" doesn't fit the context, so the caller overrides it.
   */
  title?: string;
  /**
   * Clones the new profile from the default profile to inherit model config/provider keys.
   * Enabled only when the plugin advertises `profile_clone` — an old plugin isn't sent a
   * field it doesn't know.
   */
  cloneDefaultProfile?: boolean;
  /**
   * Whether this user is the gateway owner. Only the owner can save provider keys or log
   * in (a shared user gets 403). Defaults to false when unknown — never show a button that
   * can't be pressed.
   */
  canManageProviderAuth?: boolean;
  /** Right after a profile is actually created in step 1. The outer profile list refetches immediately using this. */
  onProfileCreated?: (profileName: string) => void;
  /**
   * The wizard is done. Finishing via step 3's "Done" carries that employee's name — the
   * caller can navigate to employee detail. Ending via close/delete carries no argument.
   */
  onDone: (result?: { profileName: string }) => void;
}

/**
 * Parses the response body. **A parse failure is never claimed as success.**
 *
 * Every call site used to do `await res.json().catch(() => ({}))`. That `{}` had no
 * `errorCode`, so it passed straight through the error branch below and was treated as a
 * **successful payload**, going into screen judgment with every field `undefined`. This
 * actually happened in staging (2026-09-02): the plugin returned `isDefaultTemplate: true`,
 * but the screen asked "an identity already exists" — the fallback for a broken parse
 * happened to land on the **dangerous side**.
 *
 * Now a parse failure carries a `malformed_response` code and flows as an error. Whatever
 * the server sent (an HTML error page, an empty body, truncated JSON), the screen never
 * says "success."
 */
async function parseJsonBody(res: Response): Promise<Record<string, unknown>> {
  try {
    const parsed = await res.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { errorCode: "malformed_response" };
    }
    return parsed as Record<string, unknown>;
  } catch {
    return { errorCode: "malformed_response" };
  }
}

function extractErrorCode(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const code = (payload as { errorCode?: unknown }).errorCode;
  return typeof code === "string" ? code : null;
}

/** The raw upstream status code the 4 proxy routes carry alongside a failure response. null if absent (e.g. a network failure). */
function extractUpstreamStatus(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") return null;
  const status = (payload as { upstreamStatus?: unknown }).upstreamStatus;
  return typeof status === "number" ? status : null;
}

export default function NpcHireWizard({
  gatewayId,
  pluginStatus,
  localDiscovery,
  existingProfiles,
  initialProfile = null,
  dashboardUrl = null,
  title,
  cloneDefaultProfile = false,
  canManageProviderAuth = false,
  onProfileCreated,
  onDone,
}: NpcHireWizardProps) {
  const t = useT();

  // Arriving with `initialProfile` means step 1 (create profile) is already done — open
  // straight to step 2. But if step 2 is locked (no plugin) it can't be sent there, so it
  // falls back to step 1.
  const [current, setCurrent] = useState<WizardStep>(() =>
    initialProfile &&
    availableSteps(pluginStatus, localDiscovery, true).find((s) => s.step === "identity")?.enabled
      ? "identity"
      : "profile",
  );

  // --- Step ① profile ---
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [created, setCreated] = useState<ProvisionedProfile | null>(
    initialProfile ? { name: initialProfile, keyIssued: true, keyStored: true } : null,
  );
  /** Whether this entered via an existing profile rather than being created this session — this changes the close-confirmation wording. */
  const [resumed, setResumed] = useState(Boolean(initialProfile));
  const [serving, setServing] = useState<
    "idle" | "checking" | "served" | "key_rejected" | "not_served" | "error"
  >("idle");
  const [servingError, setServingError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [deleteShellCommand, setDeleteShellCommand] = useState<string | null>(null);
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);

  const steps = useMemo(
    () => availableSteps(pluginStatus, localDiscovery, created !== null),
    [pluginStatus, localDiscovery, created],
  );
  const stepByName = useMemo(
    () => Object.fromEntries(steps.map((s) => [s.step, s])) as Record<WizardStep, StepAvailability>,
    [steps],
  );

  // How far to inherit keys on clone. Off copies only the provider keys the default profile
  // actually uses; on copies every API-key-type provider key (excluding generic/OAuth tokens)
  // (plugin cloneKeys).
  const [copyAllApiKeys, setCopyAllApiKeys] = useState(false);
  const [copyKeysHint, setCopyKeysHint] = useState(false);
  const nameTrimmed = name.trim();
  const nameValid = nameTrimmed.length > 0 && isCreatableProfileName(nameTrimmed);

  // --- Step ② identity ---
  const [identityPayload, setIdentityPayload] = useState<IdentityPayload | null>(null);
  const [identityLoading, setIdentityLoading] = useState(false);
  const [identityError, setIdentityError] = useState("");
  const [identityMode, setIdentityMode] = useState<"keep" | "new" | "load" | null>(null);
  const [identityBody, setIdentityBody] = useState("");
  const [identitySaving, setIdentitySaving] = useState(false);
  const [identitySaved, setIdentitySaved] = useState(false);
  const [identityConflict, setIdentityConflict] = useState(false);
  // I-1: on conflict, the remote body is held here separately — the draft the user just
  // wrote (identityBody) is never silently overwritten. It only moves into identityBody
  // when the user explicitly clicks "Replace with this."
  const [conflictRemoteBody, setConflictRemoteBody] = useState<string | null>(null);

  // --- Step 3 appearance ---
  // Appearance lives on DeskRPG's hermes_profiles row — find that row's id and current value from the list.
  const [appearanceTarget, setAppearanceTarget] = useState<{
    id: string;
    appearance: CharacterAppearance | null;
  } | null>(null);
  const [appearanceError, setAppearanceError] = useState("");
  const [appearanceSaved, setAppearanceSaved] = useState(false);

  // --- Step ④ config ---
  const [configLoading, setConfigLoading] = useState(false);
  const [configError, setConfigError] = useState("");
  const [configLocked, setConfigLocked] = useState(false);
  const [model, setModel] = useState("");
  const [provider, setProvider] = useState("");
  /**
   * The endpoint that profile's requests actually go to (`model.base_url`). Changing the
   * provider leaves this value in place, so only the label shows a new provider while
   * requests still go to the old endpoint (the Hermes runtime only reads this key). Never
   * silently cleared — for someone using a custom endpoint, that address is correct.
   */
  const [baseUrl, setBaseUrl] = useState("");
  const [clearBaseUrl, setClearBaseUrl] = useState(false);
  const [toolsetsText, setToolsetsText] = useState("");
  // The toolset/skill checklist (plugin 0.9.0+). null means the server's current state is
  // the default. Only carried into the save when a human touched it — saving untouched must
  // not overwrite the current state.
  const [enabledToolsets, setEnabledToolsets] = useState<string[] | null>(null);
  const [disabledSkills, setDisabledSkills] = useState<string[] | null>(null);
  const [pickerDirty, setPickerDirty] = useState(false);
  const [pickerUnsupported, setPickerUnsupported] = useState(false);
  const [configSaving, setConfigSaving] = useState(false);
  const [configSaved, setConfigSaved] = useState(false);
  const [effort, setEffort] = useState("");
  /**
   * The model/provider/reasoning-effort list. Not cached here — Hermes already caches
   * models.dev with a 20-minute TTL, so caching it again here would double the delay before
   * "always fresh."
   */
  const [catalog, setCatalog] = useState<CatalogPayload | null>(null);
  const [catalogError, setCatalogError] = useState("");

  const profileBase = created
    ? `/api/gateways/${gatewayId}/plugin/profiles/${encodeURIComponent(created.name)}`
    : null;

  const createdName = created?.name ?? null;
  useEffect(() => {
    if (current !== "appearance" || !createdName) return;
    if (appearanceTarget || appearanceError) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/gateways/${gatewayId}/profiles`);
        const data = (await res.json().catch(() => ({}))) as {
          profiles?: Array<{ id?: unknown; profileName?: unknown; appearance?: unknown }>;
        };
        const row = (data.profiles ?? []).find((p) => p.profileName === createdName);
        if (cancelled) return;
        if (!row || typeof row.id !== "string") {
          setAppearanceError(t("hermes.wizard.appearance.loadFailed"));
          return;
        }
        setAppearanceTarget({
          id: row.id,
          appearance: (row.appearance as CharacterAppearance | null) ?? null,
        });
      } catch {
        if (!cancelled) setAppearanceError(t("errors.connectionFailed"));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [current, createdName, gatewayId, appearanceTarget, appearanceError, t]);

  /**
   * Moves a single identity response into screen state — storing it **and deciding the
   * edit mode together**.
   *
   * Step 1's serving check and step 2's lookup receive the same response. This used to have
   * step 1 store only the payload without deciding a mode, so step 2 (since a payload
   * already existed) never re-read it, fell through to mode null, and asked a just-created
   * profile "an identity already exists" (observed locally 2026-09-18).
   */
  const applyIdentityPayload = useCallback((payload: IdentityPayload) => {
    setIdentityPayload(payload);
    const decision = identityDecision(payload);
    if (decision === "edit_fresh") {
      setIdentityMode("new");
      setIdentityBody("");
    } else if (decision === "ask_overwrite") {
      setIdentityMode(null);
      setIdentityBody(payload.body ?? "");
    } else {
      // blocked — the editor doesn't open.
      setIdentityMode(null);
    }
  }, []);

  // --- Step 1 actions ---

  /**
   * Carries steps 2/3 forward with an already-registered profile.
   *
   * Since nothing is newly created, key-issuance/storage state is filled in as "already
   * there" — setting `keyIssued`/`keyStored` to true isn't a lie, it's a **fact**: this
   * profile only shows up in the list because it already has a token stored in
   * `hermes_profiles`. `resumed` is set, though, so closing doesn't ask "the just-created
   * profile will be lost" — since we didn't create it, it must not be offered for deletion.
   */
  const handleResume = useCallback((profileName: string) => {
    setCreated({ name: profileName, keyIssued: true, keyStored: true });
    setResumed(true);
    setCreateError("");
  }, []);

  const handleCreate = useCallback(async () => {
    if (!nameValid) return;
    setCreating(true);
    setCreateError("");
    try {
      const res = await fetch(`/api/gateways/${gatewayId}/plugin/profiles`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: nameTrimmed,
          ...(cloneDefaultProfile ? { cloneFrom: "default" } : {}),
          ...(cloneDefaultProfile && copyAllApiKeys ? { cloneKeys: "api_keys" } : {}),
        }),
      });
      const data = withHeaderErrorCode(await parseJsonBody(res), res.headers);
      const code = extractErrorCode(data);
      if (code) {
        setCreateError(getWizardErrorMessage(t, code));
        return;
      }
      if (!res.ok) {
        setCreateError(getLocalizedErrorMessage(t, data, "common.error"));
        return;
      }
      const profile = data as ProvisionedProfile;
      setCreated(profile);
      // The outer list used to refetch only when the wizard closed — the just-created
      // employee was missing from the list the whole time, leaving "no profiles registered"
      // in place (observed 2026-09-17).
      onProfileCreated?.(profile.name);

      // If keyStored is false, the profile token isn't in DeskRPG either way — the
      // identity/config steps need that token to be callable, so skip the serving check.
      if (!profile.keyStored) {
        setServing("idle");
        return;
      }

      setServing("checking");
      setServingError("");
      const idRes = await fetch(
        `/api/gateways/${gatewayId}/plugin/profiles/${encodeURIComponent(profile.name)}/identity`,
      );
      const idData = withHeaderErrorCode(await idRes.json().catch(() => ({})), idRes.headers);
      const idCode = extractErrorCode(idData);
      // Verdict I: doesn't use the served_profiles snapshot — decides by actually calling
      // the just-created profile. Fix round 1: since the proxy now also sends
      // `upstreamStatus`, this distinguishes 401 (key problem) from 404 (not served, per
      // allowlist) — fixing here the problem (flagged in review) where both collapsed into
      // `plugin_error`.
      const verdict = classifyServingCheck({
        errorCode: idCode,
        upstreamStatus: extractUpstreamStatus(idData),
      });
      if (verdict === "served") {
        setServing("served");
        applyIdentityPayload(idData as IdentityPayload);
      } else if (verdict === "key_rejected") {
        setServing("key_rejected");
      } else if (verdict === "not_served") {
        setServing("not_served");
      } else {
        setServing("error");
        setServingError(getWizardErrorMessage(t, idCode));
      }
    } catch {
      setCreateError(t("errors.connectionFailed"));
    } finally {
      setCreating(false);
    }
  }, [
    applyIdentityPayload,
    cloneDefaultProfile,
    copyAllApiKeys,
    gatewayId,
    nameTrimmed,
    nameValid,
    onProfileCreated,
    t,
  ]);

  const handleDeleteCreated = useCallback(async () => {
    if (!created) return;
    setDeleting(true);
    setDeleteError("");
    setDeleteShellCommand(null);
    try {
      const res = await fetch(
        `/api/gateways/${gatewayId}/plugin/profiles/${encodeURIComponent(created.name)}`,
        { method: "DELETE" },
      );
      const data = withHeaderErrorCode(await parseJsonBody(res), res.headers) as ProxyFailure;
      const code = extractErrorCode(data);
      if (code) {
        setDeleteError(getWizardErrorMessage(t, code));
        if (data.shellCommand) setDeleteShellCommand(data.shellCommand);
        return;
      }
      if (!res.ok) {
        setDeleteError(getLocalizedErrorMessage(t, data, "common.error"));
        return;
      }
      // It's deleted, so start over — close the wizard.
      setCreated(null);
      setShowCloseConfirm(false);
      onDone();
    } catch {
      setDeleteError(t("errors.connectionFailed"));
    } finally {
      setDeleting(false);
    }
  }, [created, gatewayId, onDone, t]);

  // --- Step 2 actions ---

  const loadIdentity = useCallback(async () => {
    if (!profileBase) return;
    setIdentityLoading(true);
    setIdentityError("");
    setIdentityConflict(false);
    setConflictRemoteBody(null);
    setIdentitySaved(false);
    try {
      const res = await fetch(`${profileBase}/identity`);
      const data = withHeaderErrorCode(await parseJsonBody(res), res.headers);
      const code = extractErrorCode(data);
      if (code) {
        setIdentityError(getWizardErrorMessage(t, code));
        setIdentityPayload(null);
        return;
      }
      applyIdentityPayload(data as IdentityPayload);
    } catch {
      setIdentityError(t("errors.connectionFailed"));
    } finally {
      setIdentityLoading(false);
    }
  }, [applyIdentityPayload, profileBase, t]);

  // A failed load leaves no payload and nothing loading — without the error guard this effect
  // fires again at once and hammers the gateway (the config and catalog loads guard the same way).
  useEffect(() => {
    if (current === "identity" && !identityPayload && !identityLoading && !identityError) {
      void loadIdentity();
    }
  }, [current, identityPayload, identityLoading, identityError, loadIdentity]);

  // I-1: a **dedicated** refetch for when `revision_conflict`/`revision_mismatch` is hit
  // (defect 8 — the code the plugin actually emits is the latter). `loadIdentity` isn't
  // reused — that function clears `identityConflict` on its first line and resets
  // `identityMode`/`identityBody` based on the `identityDecision` result. That caused a bug
  // where the banner turned on and off in the same tick, silently replacing the user's
  // just-written draft with the remote body (review Important-1). This function only
  // refreshes the revision and leaves the user's draft/current mode untouched.
  const refetchIdentityForConflict = useCallback(async () => {
    if (!profileBase) return;
    try {
      const res = await fetch(`${profileBase}/identity`);
      const data = withHeaderErrorCode(await parseJsonBody(res), res.headers);
      const code = extractErrorCode(data);
      if (code) {
        // The refetch itself failed — keep the conflict banner but can't show the remote body.
        setIdentityError(getWizardErrorMessage(t, code));
        return;
      }
      const payload = data as IdentityPayload;
      setIdentityPayload((prev) => (prev ? { ...prev, revision: payload.revision } : payload));
      setConflictRemoteBody(payload.body ?? "");
    } catch {
      setIdentityError(t("errors.connectionFailed"));
    }
  }, [profileBase, t]);

  const handleSaveIdentity = useCallback(async () => {
    if (!profileBase || !identityPayload) return;
    setIdentitySaving(true);
    setIdentityError("");
    setIdentitySaved(false);
    try {
      const res = await fetch(`${profileBase}/identity`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: identityBody, ifRevision: identityPayload.revision ?? "" }),
      });
      const data = withHeaderErrorCode(await parseJsonBody(res), res.headers);
      const code = extractErrorCode(data);
      // Defect 8: the code the plugin actually emits is `revision_mismatch` (the spec said
      // `revision_conflict`, but the implementation didn't match it) — both are accepted.
      if (code === "revision_conflict" || code === "revision_mismatch") {
        setIdentityConflict(true);
        await refetchIdentityForConflict();
        return;
      }
      if (code) {
        setIdentityError(getWizardErrorMessage(t, code));
        return;
      }
      if (!res.ok) {
        setIdentityError(getLocalizedErrorMessage(t, data, "common.error"));
        return;
      }
      const saved = data as { revision: string };
      setIdentityPayload((prev) => (prev ? { ...prev, revision: saved.revision } : prev));
      setIdentityConflict(false);
      setConflictRemoteBody(null);
      setIdentitySaved(true);
    } catch {
      setIdentityError(t("errors.connectionFailed"));
    } finally {
      setIdentitySaving(false);
    }
  }, [identityBody, identityPayload, profileBase, refetchIdentityForConflict, t]);

  // --- Step 3 actions ---

  const loadConfig = useCallback(async () => {
    if (!profileBase) return;
    setConfigLoading(true);
    setConfigError("");
    setConfigLocked(false);
    try {
      const res = await fetch(`${profileBase}/config`);
      const data = withHeaderErrorCode(await parseJsonBody(res), res.headers);
      const code = extractErrorCode(data);
      if (code) {
        // Both "unreadable" (the 200 branch) and "config_unreadable" (409) lock the form —
        // saving an empty form would erase the existing config.
        if (code === "unreadable" || code === "config_unreadable") {
          setConfigLocked(true);
        }
        setConfigError(getWizardErrorMessage(t, code));
        return;
      }
      const record = data as Record<string, unknown>;
      setModel(typeof record.model === "string" ? record.model : "");
      setProvider(typeof record.provider === "string" ? record.provider : "");
      setBaseUrl(typeof record.baseUrl === "string" ? record.baseUrl : "");
      setClearBaseUrl(false);
      setEffort(typeof record.reasoning_effort === "string" ? record.reasoning_effort : "");
      const toolsets = record.toolsets;
      setToolsetsText(
        Array.isArray(toolsets) ? toolsets.filter((x) => typeof x === "string").join(", ") : "",
      );
    } catch {
      setConfigError(t("errors.connectionFailed"));
    } finally {
      setConfigLoading(false);
    }
  }, [profileBase, t]);

  useEffect(() => {
    if (
      current === "config" &&
      !configLoading &&
      !model &&
      !provider &&
      !toolsetsText &&
      !configError
    ) {
      void loadConfig();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  /**
   * Fetches the model/provider list. A failure doesn't block step 3 — with no list, it
   * just falls back to free-text input, which is the old behavior. Blocking config entirely
   * because a dropdown couldn't be filled would be a regression.
   */
  const loadCatalog = useCallback(async () => {
    if (!profileBase) return;
    setCatalogError("");
    try {
      const res = await fetch(`${profileBase}/catalog`);
      const data = withHeaderErrorCode(await parseJsonBody(res), res.headers);
      const code = extractErrorCode(data);
      if (code) {
        setCatalogError(getWizardErrorMessage(t, code));
        setCatalog(null);
        return;
      }
      setCatalog(data as unknown as CatalogPayload);
    } catch {
      setCatalogError(t("errors.connectionFailed"));
      setCatalog(null);
    }
  }, [profileBase, t]);

  // Fetch the catalog once on entering step 3. This is a separate effect since it's
  // independent of config loading — one failing doesn't block the other from proceeding.
  useEffect(() => {
    if (current === "config" && profileBase && !catalog && !catalogError) {
      void loadCatalog();
    }
  }, [current, profileBase, catalog, catalogError, loadCatalog]);

  const handleSaveConfig = useCallback(async () => {
    if (!profileBase) return;
    setConfigSaving(true);
    setConfigError("");
    setConfigSaved(false);
    try {
      const patch: Record<string, unknown> = {};
      if (model.trim()) patch.model = model.trim();
      if (provider.trim()) patch.provider = provider.trim();
      if (!pickerUnsupported) {
        // The checklist uses the platform-specific toolsets that actually take effect in
        // conversation. The top-level `toolsets` field doesn't affect conversation, so it's
        // never sent alongside it (plugin 0.9.0 contract).
        if (pickerDirty && enabledToolsets) patch.enabledToolsets = enabledToolsets;
        if (pickerDirty && disabledSkills) patch.disabledSkills = disabledSkills;
      } else {
        const toolsets = toolsetsText
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (toolsets.length > 0) patch.toolsets = toolsets;
      }
      // An empty string is sent too — it's the only way to revert to "unspecified."
      // Gating this on a condition would make an effort, once chosen, impossible to clear
      // from the screen.
      if (catalog) patch.reasoning_effort = effort;
      // Clear the endpoint only when the user has confirmed it (a signal from plugin 0.10.1).
      if (clearBaseUrl && baseUrl) patch.clearBaseUrl = true;

      const res = await fetch(`${profileBase}/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = withHeaderErrorCode(await parseJsonBody(res), res.headers);
      const code = extractErrorCode(data);
      if (code) {
        setConfigError(getWizardErrorMessage(t, code));
        return;
      }
      if (!res.ok) {
        setConfigError(getLocalizedErrorMessage(t, data, "common.error"));
        return;
      }
      setConfigSaved(true);
      if (patch.clearBaseUrl) {
        setBaseUrl("");
        setClearBaseUrl(false);
      }
    } catch {
      setConfigError(t("errors.connectionFailed"));
    } finally {
      setConfigSaving(false);
    }
  }, [
    baseUrl,
    catalog,
    clearBaseUrl,
    disabledSkills,
    effort,
    enabledToolsets,
    model,
    pickerDirty,
    pickerUnsupported,
    profileBase,
    provider,
    t,
    toolsetsText,
  ]);

  // --- Navigation ---

  const goNext = useCallback(() => {
    const next = nextStep(current, steps);
    if (next) setCurrent(next);
  }, [current, steps]);

  const goBack = useCallback(() => {
    const previous = previousStep(current, steps);
    if (previous) setCurrent(previous);
  }, [current, steps]);

  const requestClose = useCallback(() => {
    // If `resumed`, this profile **wasn't created by us** — it must not be offered for
    // deletion. The confirmation panel's wording is "the just-created profile will be lost,
    // delete it?", and showing that for someone else's profile would nudge the user into a
    // mistake.
    if (created && !resumed && !showCloseConfirm) {
      setShowCloseConfirm(true);
      return;
    }
    onDone();
  }, [created, resumed, onDone, showCloseConfirm]);

  // ---------------------------------------------------------------------------

  // I-2: the delete-failure display is factored into one piece shared by two places (the
  // close-confirmation panel and step 1's keyIssued:false box "delete and retry"). This
  // state used to render only in the close-confirmation panel, so on the keyIssued:false
  // side a `profile_has_service` rejection would discard the shell command entirely and
  // show nothing on screen.
  const deleteFailureBlock = (deleteError || deleteShellCommand) && (
    <div className="space-y-1">
      {deleteError && <p className="text-xs text-danger">{deleteError}</p>}
      {deleteShellCommand && (
        <div className="space-y-1">
          <p className="text-xs text-text-muted">{t("hermes.wizard.deleteFailedShell")}</p>
          <pre className="overflow-x-auto rounded bg-bg px-3 py-2 text-xs text-text">
            {deleteShellCommand}
          </pre>
        </div>
      )}
    </div>
  );

  // Plugin 0.9.0+ carries an auth method (authType) on catalog rows — that means keys can be
  // entered or logins done right inside DeskRPG, so an unauthenticated provider can still be
  // picked and authenticated via the panel below.
  const inAppAuth = Boolean(catalog?.providers.some((p) => p.authType));
  const selectedProviderRow = catalog?.providers.find((p) => p.id === provider) ?? null;
  // If the list arrived but the picked provider isn't authenticated yet, models can't be
  // chosen (the list won't come back).
  const providerAwaitingAuth = Boolean(selectedProviderRow && !selectedProviderRow.authenticated);
  const catalogModels = catalog?.models[provider] ?? [];
  // Put the stored model first even if it's not in the list, so the dropdown never silently clears it.
  const modelOptions =
    catalogModels.length > 0 && model && !catalogModels.includes(model)
      ? [model, ...catalogModels]
      : catalogModels;

  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">{title ?? t("hermes.wizard.title")}</h2>
        <button
          type="button"
          onClick={requestClose}
          className="rounded bg-surface-raised px-3 py-1.5 text-xs font-semibold hover:bg-surface-raised/80"
        >
          {t("hermes.wizard.close")}
        </button>
      </div>

      {/* A locked step still stays visible grayed out — if it disappeared, the user wouldn't even know the feature exists. */}
      <div className="mb-5 flex flex-wrap gap-2">
        {steps.map((s) => (
          <button
            key={s.step}
            type="button"
            disabled={!s.enabled}
            onClick={() => s.enabled && setCurrent(s.step)}
            title={s.lockedReason ? t(s.lockedReason) : undefined}
            className={`rounded-full border px-3 py-1 text-xs font-semibold ${
              current === s.step
                ? "border-primary bg-primary/10 text-primary"
                : s.enabled
                  ? "border-border bg-surface-raised text-text hover:bg-surface-raised/80"
                  : "border-border/60 bg-surface-raised/40 text-text-muted"
            }`}
          >
            {t(`hermes.wizard.step.${s.step}`)}
          </button>
        ))}
      </div>
      {showCloseConfirm && created && (
        <div className="mb-4 space-y-2 rounded-lg border border-npc/40 bg-npc/10 p-3">
          <p className="text-sm font-semibold text-npc-dark">
            {t("hermes.wizard.closeConfirmTitle")}
          </p>
          <p className="text-sm text-text-muted">
            {t("hermes.wizard.closeConfirmBody", { name: created.name })}
          </p>
          {deleteFailureBlock}
          <div className="flex gap-2">
            <button
              type="button"
              disabled={deleting}
              onClick={() => void handleDeleteCreated()}
              className="rounded bg-danger/80 px-3 py-1.5 text-xs font-semibold text-white hover:bg-danger disabled:opacity-60"
            >
              {deleting ? t("common.loading") : t("hermes.wizard.closeConfirmDelete")}
            </button>
            <button
              type="button"
              onClick={() => onDone()}
              className="rounded bg-surface-raised px-3 py-1.5 text-xs font-semibold hover:bg-surface-raised/80"
            >
              {t("hermes.wizard.closeConfirmKeep")}
            </button>
            <button
              type="button"
              onClick={() => setShowCloseConfirm(false)}
              className="rounded px-3 py-1.5 text-xs font-semibold text-text-muted hover:text-text"
            >
              {t("hermes.wizard.back")}
            </button>
          </div>
        </div>
      )}

      {!showCloseConfirm && current === "profile" && stepByName.profile?.enabled && (
        <div className="space-y-3">
          {pluginStatus !== "plugin_ready" ? (
            <p className="text-sm text-text-muted">{t("hermes.wizard.profile.needsPlugin")}</p>
          ) : !created ? (
            <>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("hermes.wizard.profile.namePlaceholder")}
                className="w-full rounded border border-border bg-bg px-3 py-2 text-sm text-text focus:outline-none focus:border-primary-light"
              />
              <p className="text-xs text-text-muted">{t("hermes.wizard.profile.nameHint")}</p>
              {existingProfiles.length > 0 && (
                <div className="space-y-1 border-t border-border pt-3">
                  <p className="text-xs text-text-muted">{t("hermes.wizard.profile.resumeHint")}</p>
                  <div className="flex flex-wrap gap-2">
                    {existingProfiles.map((profileName) => (
                      <button
                        key={profileName}
                        type="button"
                        onClick={() => handleResume(profileName)}
                        className="rounded bg-surface-raised px-3 py-1.5 text-xs font-semibold hover:bg-surface-raised/80"
                      >
                        {profileName}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {cloneDefaultProfile && (
                <label className="flex items-start gap-2 text-sm text-text">
                  <input
                    type="checkbox"
                    checked={copyAllApiKeys}
                    onChange={(e) => setCopyAllApiKeys(e.target.checked)}
                    className="mt-0.5"
                  />
                  <span>
                    {t("hermes.wizard.profile.copyAllApiKeys")}
                    {/* The details only show up when clicked — two lines under the checkbox made the screen too long. */}
                    <button
                      type="button"
                      aria-label={t("hermes.wizard.profile.copyAllApiKeysHint")}
                      aria-expanded={copyKeysHint}
                      data-hint="copy-all-api-keys"
                      className="ml-2 inline-flex h-5 w-5 items-center justify-center rounded-full border border-border text-xs font-semibold text-text-muted hover:bg-surface-raised"
                      onClick={(e) => {
                        e.preventDefault();
                        setCopyKeysHint((open) => !open);
                      }}
                    >
                      ?
                    </button>
                    {copyKeysHint && (
                      <span className="mt-1 block text-xs text-text-muted">
                        {t("hermes.wizard.profile.copyAllApiKeysHint")}
                      </span>
                    )}
                  </span>
                </label>
              )}
              {nameTrimmed.length > 0 && !nameValid && (
                <p className="text-xs text-danger">{t("hermes.wizard.profile.nameInvalid")}</p>
              )}
              {createError && <p className="text-sm text-danger">{createError}</p>}
              <button
                type="button"
                disabled={!nameValid || creating}
                onClick={() => void handleCreate()}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-hover disabled:opacity-60"
              >
                {creating ? t("hermes.wizard.profile.creating") : t("hermes.wizard.profile.create")}
              </button>
            </>
          ) : (
            <div className="space-y-2">
              <p className="text-sm text-text">
                {t("hermes.wizard.profile.created", { name: created.name })}
              </p>
              {created.cloned && !created.cloneError && (
                <p className="text-xs text-text-muted">{t("hermes.wizard.profile.cloned")}</p>
              )}
              {created.cloneError && (
                // The profile was still created — the model can be picked directly in step 3. This just notifies, it doesn't block.
                <p className="text-xs text-npc-dark">{t("hermes.wizard.profile.cloneFailed")}</p>
              )}

              {!created.keyIssued && (
                <div className="space-y-2 rounded-lg border border-npc/40 bg-npc/10 p-3">
                  <p className="text-sm font-semibold text-npc-dark">
                    {t("hermes.wizard.profile.keyIssuedFalseTitle")}
                  </p>
                  {created.keyError && (
                    <p className="text-xs text-text-muted">{created.keyError}</p>
                  )}
                  {deleteFailureBlock}
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={deleting}
                      onClick={() => void handleDeleteCreated()}
                      className="rounded bg-danger/80 px-3 py-1.5 text-xs font-semibold text-white hover:bg-danger disabled:opacity-60"
                    >
                      {t("hermes.wizard.profile.deleteAndRetry")}
                    </button>
                    <button
                      type="button"
                      onClick={() => onDone()}
                      className="rounded bg-surface-raised px-3 py-1.5 text-xs font-semibold hover:bg-surface-raised/80"
                    >
                      {t("hermes.wizard.profile.enterKeyInShell")}
                    </button>
                  </div>
                </div>
              )}

              {created.keyIssued && !created.keyStored && (
                <div className="space-y-2 rounded-lg border border-danger/40 bg-danger/10 p-3">
                  <p className="text-sm font-semibold text-danger">
                    {t("hermes.wizard.profile.keyStoredFalseTitle")}
                  </p>
                  {created.keyStoredError && (
                    // Final review M-3: this value is now a code, not a Korean sentence —
                    // it must be translated through the wizard-error-codes dictionary so
                    // en/ja/zh users can also read it.
                    <p className="text-xs text-text-muted">
                      {getWizardErrorMessage(t, created.keyStoredError)}
                    </p>
                  )}
                </div>
              )}

              {created.keyStored && (
                <>
                  {serving === "checking" && (
                    <p className="text-sm text-text-muted">
                      {t("hermes.wizard.profile.verifying")}
                    </p>
                  )}
                  {serving === "served" && (
                    <p className="text-sm text-success">{t("hermes.wizard.profile.served")}</p>
                  )}
                  {serving === "key_rejected" && (
                    <p className="text-sm text-danger">{t("hermes.wizard.profile.keyRejected")}</p>
                  )}
                  {serving === "not_served" && (
                    <p className="text-sm text-danger">{t("hermes.wizard.profile.notServed")}</p>
                  )}
                  {serving === "error" && <p className="text-sm text-danger">{servingError}</p>}
                  {serving === "served" && (
                    <button
                      type="button"
                      onClick={goNext}
                      className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-hover"
                    >
                      {t("hermes.wizard.profile.continue")}
                    </button>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}

      {!showCloseConfirm && current === "identity" && stepByName.identity?.enabled && (
        <div className="space-y-3">
          {identityLoading ? (
            <p className="text-sm text-text-muted">{t("hermes.wizard.identity.loading")}</p>
          ) : identityError && !identityPayload ? (
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm text-danger">{identityError}</p>
              <button
                type="button"
                data-identity-retry
                onClick={() => void loadIdentity()}
                className="rounded bg-surface-raised px-3 py-1.5 text-xs font-semibold text-text hover:bg-surface-raised/80"
              >
                {t("common.retry")}
              </button>
            </div>
          ) : identityError ? (
            <p className="text-sm text-danger">{identityError}</p>
          ) : !identityPayload ? (
            // The one tick before the lookup starts. This used to collapse null here into
            // "unreadable," showing "can't read the identity file..." before the lookup had
            // even begun.
            <p className="text-sm text-text-muted">{t("hermes.wizard.identity.loading")}</p>
          ) : identityPayload.unreadable || identityDecision(identityPayload) === "blocked" ? (
            <p className="text-sm text-danger">{t("hermes.wizard.identity.blocked")}</p>
          ) : identityMode === null && identityPayload ? (
            <div className="space-y-2">
              <p className="text-sm text-text">{t("hermes.wizard.identity.askOverwriteTitle")}</p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setIdentityMode("keep")}
                  className="rounded bg-surface-raised px-3 py-1.5 text-xs font-semibold hover:bg-surface-raised/80"
                >
                  {t("hermes.wizard.identity.keepExisting")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setIdentityMode("new");
                    setIdentityBody("");
                  }}
                  className="rounded bg-surface-raised px-3 py-1.5 text-xs font-semibold hover:bg-surface-raised/80"
                >
                  {t("hermes.wizard.identity.writeNew")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setIdentityMode("load");
                    setIdentityBody(identityPayload.body ?? "");
                  }}
                  className="rounded bg-surface-raised px-3 py-1.5 text-xs font-semibold hover:bg-surface-raised/80"
                >
                  {t("hermes.wizard.identity.loadForEdit")}
                </button>
              </div>
            </div>
          ) : identityMode === "keep" ? (
            <div className="flex items-center justify-between">
              <p className="text-sm text-text-muted">{t("hermes.wizard.identity.skip")}</p>
              <button
                type="button"
                onClick={goNext}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-hover"
              >
                {t("hermes.wizard.next")}
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              {identityConflict && (
                // I-1: the banner never dismisses itself or silently overwrites the user's
                // draft. The `identityBody` in the textarea below stays exactly as-is,
                // independent of this block — it's only replaced when the user explicitly
                // clicks "Replace with this."
                <div className="space-y-2 rounded-lg border border-npc/40 bg-npc/10 p-3">
                  <p className="text-sm font-semibold text-npc-dark">
                    {t("hermes.wizard.identity.conflict")}
                  </p>
                  {conflictRemoteBody !== null && (
                    <div className="max-h-32 overflow-y-auto whitespace-pre-wrap rounded bg-bg px-3 py-2 text-xs text-text-muted">
                      {conflictRemoteBody || t("hermes.wizard.identity.conflictRemoteEmpty")}
                    </div>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => setIdentityConflict(false)}
                      className="rounded bg-surface-raised px-3 py-1.5 text-xs font-semibold hover:bg-surface-raised/80"
                    >
                      {t("hermes.wizard.identity.conflictKeepDraft")}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setIdentityBody(conflictRemoteBody ?? "");
                        setIdentityConflict(false);
                        setConflictRemoteBody(null);
                      }}
                      className="rounded bg-surface-raised px-3 py-1.5 text-xs font-semibold hover:bg-surface-raised/80"
                    >
                      {t("hermes.wizard.identity.conflictUseRemote")}
                    </button>
                  </div>
                </div>
              )}
              <textarea
                value={identityBody}
                onChange={(e) => {
                  setIdentityBody(e.target.value);
                  setIdentitySaved(false);
                }}
                placeholder={t("hermes.wizard.identity.placeholder")}
                rows={8}
                className="w-full rounded border border-border bg-bg px-3 py-2 text-sm text-text focus:outline-none focus:border-primary-light"
              />
              {identitySaved && (
                <p className="text-xs text-success">{t("hermes.wizard.identity.saved")}</p>
              )}
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={identitySaving}
                  onClick={() => void handleSaveIdentity()}
                  className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-hover disabled:opacity-60"
                >
                  {identitySaving
                    ? t("hermes.wizard.identity.saving")
                    : t("hermes.wizard.identity.save")}
                </button>
                <button
                  type="button"
                  onClick={goNext}
                  className="rounded bg-surface-raised px-4 py-2 text-sm font-semibold hover:bg-surface-raised/80"
                >
                  {t("hermes.wizard.next")}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {!showCloseConfirm && current === "appearance" && stepByName.appearance?.enabled && (
        <div className="space-y-3">
          {appearanceError ? (
            <p className="text-sm text-danger">{appearanceError}</p>
          ) : !appearanceTarget ? (
            <p className="text-sm text-text-muted">{t("common.loading")}</p>
          ) : (
            <ProfileAppearanceEditor
              key={appearanceTarget.id}
              gatewayId={gatewayId}
              profileId={appearanceTarget.id}
              initialAppearance={appearanceTarget.appearance}
              onSaved={() => setAppearanceSaved(true)}
            />
          )}
          {appearanceSaved && (
            <p className="text-xs text-success">{t("hermes.wizard.appearance.saved")}</p>
          )}
          <button
            type="button"
            onClick={goNext}
            className="rounded bg-surface-raised px-4 py-2 text-sm font-semibold hover:bg-surface-raised/80"
          >
            {t("hermes.wizard.next")}
          </button>
        </div>
      )}

      {!showCloseConfirm && current === "config" && stepByName.config?.enabled && (
        <div className="space-y-3">
          {configLoading ? (
            <p className="text-sm text-text-muted">{t("hermes.wizard.config.loading")}</p>
          ) : configLocked ? (
            <p className="text-sm text-danger">{t("hermes.wizard.config.locked")}</p>
          ) : (
            <>
              {configError && !configLocked && <p className="text-sm text-danger">{configError}</p>}
              {catalogError && <p className="text-xs text-text-muted">{catalogError}</p>}
              {created && !inAppAuth && (
                // Hermes logs in per NPC (profile) — a subscription logged in as default
                // isn't inherited by a new employee (upstream #111724). The list's "not
                // authenticated" alone gives no clue where to log in, so this sends the
                // user straight to that employee profile's login screen.
                <div className="space-y-2 rounded border border-border bg-surface-raised/40 p-3 text-xs text-text-muted">
                  <p>{t("hermes.wizard.config.loginHint", { name: created.name })}</p>
                  <div className="flex flex-wrap items-center gap-2">
                    {profileLoginUrl(dashboardUrl, created.name) ? (
                      <a
                        href={profileLoginUrl(dashboardUrl, created.name) ?? undefined}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="rounded bg-primary px-3 py-1.5 font-semibold text-white hover:bg-primary-hover"
                      >
                        {t("hermes.wizard.config.loginOpen", { name: created.name })}
                      </a>
                    ) : (
                      <span>
                        {t("hermes.wizard.config.loginNoDashboard", { name: created.name })}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => void loadCatalog()}
                      className="rounded bg-surface-raised px-3 py-1.5 font-semibold text-text hover:bg-surface-raised/80"
                    >
                      {t("hermes.wizard.config.loginRecheck")}
                    </button>
                  </div>
                </div>
              )}
              <div className="grid gap-2 sm:grid-cols-2">
                {/* The provider is chosen first — the model list comes from it. An
                    unauthenticated one stays in the list too (removing it would leave "why
                    is my model missing" unanswerable). If in-app auth is available (0.9.0+
                    and owner), it can be picked and authenticated via the panel below;
                    otherwise it can't be picked. Falls back to free-text input as before if
                    the list couldn't be fetched. */}
                {catalog ? (
                  <select
                    value={provider}
                    onChange={(e) => {
                      setProvider(e.target.value);
                      // When the provider changes, the previous model no longer belongs to
                      // it. Leaving it in place would only fail at save time.
                      setModel("");
                    }}
                    className="rounded border border-border bg-bg px-3 py-2 text-sm text-text focus:outline-none focus:border-primary-light"
                  >
                    <option value="">{t("hermes.wizard.config.provider")}</option>
                    {catalog.providers.map((p) => (
                      <option
                        key={p.id}
                        value={p.id}
                        disabled={!p.authenticated && !(inAppAuth && canManageProviderAuth)}
                      >
                        {p.name}
                        {p.authenticated ? "" : ` — ${t("hermes.wizard.config.notAuthenticated")}`}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={provider}
                    onChange={(e) => setProvider(e.target.value)}
                    placeholder={t("hermes.wizard.config.provider")}
                    className="rounded border border-border bg-bg px-3 py-2 text-sm text-text focus:outline-none focus:border-primary-light"
                  />
                )}

                {providerAwaitingAuth ? (
                  // The plugin gives models only for an authenticated provider. With no
                  // list before authentication, this used to fall back to free-text input
                  // — instead it shows that it can't be picked, and refetches the list
                  // after login.
                  <select
                    value={model}
                    disabled
                    title={t("hermes.wizard.config.modelAfterAuth")}
                    className="rounded border border-border bg-bg px-3 py-2 text-sm text-text-muted opacity-70"
                  >
                    <option value={model}>
                      {model || t("hermes.wizard.config.modelAfterAuth")}
                    </option>
                  </select>
                ) : modelOptions.length > 0 ? (
                  <select
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    className="rounded border border-border bg-bg px-3 py-2 text-sm text-text focus:outline-none focus:border-primary-light"
                  >
                    <option value="">{t("hermes.wizard.config.model")}</option>
                    {modelOptions.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder={t("hermes.wizard.config.model")}
                    className="rounded border border-border bg-bg px-3 py-2 text-sm text-text focus:outline-none focus:border-primary-light"
                  />
                )}
              </div>

              {selectedProviderRow?.authType &&
                (canManageProviderAuth ? (
                  <ProviderAuthPanel
                    profileBase={profileBase ?? ""}
                    provider={selectedProviderRow}
                    onAuthenticated={() => void loadCatalog()}
                    disabled={configSaving}
                  />
                ) : (
                  !selectedProviderRow.authenticated && (
                    <p className="text-xs text-text-muted">
                      {t("hermes.wizard.config.ownerMustAuthenticate")}
                    </p>
                  )
                ))}

              {catalog && catalog.reasoningEfforts.length > 0 && (
                <select
                  value={effort}
                  onChange={(e) => setEffort(e.target.value)}
                  className="w-full rounded border border-border bg-bg px-3 py-2 text-sm text-text focus:outline-none focus:border-primary-light"
                >
                  <option value="">{t("hermes.wizard.config.effort")}</option>
                  {catalog.reasoningEfforts.map((e2) => (
                    <option key={e2} value={e2}>
                      {e2}
                    </option>
                  ))}
                </select>
              )}
              {/* Tools/skills aren't something a first-time user picks — leave them at default and collapse this section. */}
              <details className="rounded border border-border px-3 py-2">
                <summary className="cursor-pointer text-sm font-semibold text-text">
                  {t("hermes.wizard.config.advanced")}
                </summary>
                <div className="mt-2 space-y-1">
                  {profileBase && !pickerUnsupported ? (
                    <ToolsetSkillPicker
                      profileBase={profileBase}
                      enabledToolsets={enabledToolsets}
                      onEnabledToolsetsChange={(next) => {
                        setEnabledToolsets(next);
                        setPickerDirty(true);
                      }}
                      disabledSkills={disabledSkills}
                      onDisabledSkillsChange={(next) => {
                        setDisabledSkills(next);
                        setPickerDirty(true);
                      }}
                      onLoaded={(initial) => {
                        setEnabledToolsets(initial.enabledToolsets);
                        setDisabledSkills(initial.disabledSkills);
                      }}
                      onUnsupported={() => setPickerUnsupported(true)}
                      canManageToolProviders={canManageProviderAuth}
                      disabled={configSaving}
                    />
                  ) : (
                    // An old plugin (< 0.9.0) doesn't give a list — names are typed in as before.
                    <>
                      <input
                        type="text"
                        value={toolsetsText}
                        onChange={(e) => setToolsetsText(e.target.value)}
                        placeholder={t("hermes.wizard.config.toolsets")}
                        className="w-full rounded border border-border bg-bg px-3 py-2 text-sm text-text focus:outline-none focus:border-primary-light"
                      />
                      <p className="text-xs text-text-muted">
                        {t("hermes.wizard.config.toolsetsHint")}
                      </p>
                    </>
                  )}
                </div>
              </details>
              {configSaved && (
                <p className="text-xs text-success">{t("hermes.wizard.config.saved")}</p>
              )}
              {/* One-line attendance result — never says "attended" without an attached
                  channel. Says nothing for an existing employee continued from editing
                  (no `attendedChannels`), since that can't be known. */}
              {typeof created?.attendedChannels === "number" && (
                <p className="text-sm text-text-muted">
                  {created.attendedChannels === 0
                    ? t("hermes.wizard.result.noChannel", { name: created.name })
                    : t("hermes.wizard.result.attended", {
                        name: created.name,
                        count: String(created.attendedChannels),
                      })}
                </p>
              )}
              {created?.workerPlugin &&
                "skipped" in created.workerPlugin &&
                created.workerPlugin.skipped === "propagation_disabled" && (
                  <div
                    className="space-y-1 rounded-lg border border-npc/40 bg-npc/10 p-3 text-xs"
                    data-worker-propagation-notice="disabled"
                  >
                    <p className="font-semibold text-text">
                      {t("hermes.wizard.result.workerPropagationOff")}
                    </p>
                    <p className="text-text-muted">
                      {t("hermes.wizard.result.workerPropagationHow")}
                    </p>
                    <Link
                      href={`/gateways?gateway=${encodeURIComponent(gatewayId)}`}
                      className="inline-block text-primary hover:underline"
                    >
                      {t("hermes.wizard.result.workerPropagationLink")}
                    </Link>
                  </div>
                )}
              {created?.attendedChannels === 0 && (
                <Link
                  href={`/channels/create?gatewayId=${encodeURIComponent(gatewayId)}`}
                  className="inline-block rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-hover"
                >
                  {t("hermes.wizard.result.createOffice")}
                </Link>
              )}
              {/* The warning stays outside the button row — in the same flex row it squeezes the buttons and wraps their text vertically. */}
              {baseUrl && provider.trim() !== "custom" && (
                <div
                  className="space-y-1 rounded-lg border border-npc/40 bg-npc/10 p-3 text-xs"
                  data-base-url-warning={baseUrl}
                >
                  <p className="text-text">
                    {t("hermes.wizard.config.baseUrlWarning", { url: baseUrl })}
                  </p>
                  <label className="flex items-start gap-2 text-text">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={clearBaseUrl}
                      onChange={(e) => setClearBaseUrl(e.target.checked)}
                    />
                    <span>{t("hermes.wizard.config.baseUrlClear")}</span>
                  </label>
                  <p className="text-text-muted">{t("hermes.wizard.config.baseUrlKeepHint")}</p>
                </div>
              )}
              <div className="flex flex-wrap gap-2" data-config-actions>
                <button
                  type="button"
                  disabled={configSaving}
                  onClick={() => void handleSaveConfig()}
                  className="shrink-0 whitespace-nowrap rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-hover disabled:opacity-60"
                >
                  {configSaving ? t("hermes.wizard.config.saving") : t("hermes.wizard.config.save")}
                </button>
                <button
                  type="button"
                  onClick={() => onDone(created ? { profileName: created.name } : undefined)}
                  className="shrink-0 whitespace-nowrap rounded bg-surface-raised px-4 py-2 text-sm font-semibold hover:bg-surface-raised/80"
                >
                  {t("hermes.wizard.finish")}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Step navigation happens through the buttons below — instead of spelling out a
          locked step's reason in text, clicking "Next" walks through the order naturally
          (Dante's decision, 2026-09-20). */}
      {!showCloseConfirm && (
        <div className="mt-6 flex items-center justify-between border-t border-border pt-4">
          <button
            type="button"
            disabled={!previousStep(current, steps)}
            onClick={goBack}
            data-step-nav="back"
            className="rounded-lg bg-surface-raised px-4 py-2 text-sm font-semibold hover:bg-surface-raised/80 disabled:opacity-40"
          >
            {t("hermes.wizard.back")}
          </button>
          <button
            type="button"
            disabled={!nextStep(current, steps)}
            onClick={goNext}
            data-step-nav="next"
            title={
              nextLockedReason(current, steps) ? t(nextLockedReason(current, steps)!) : undefined
            }
            className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-hover disabled:opacity-40"
          >
            {t("hermes.wizard.next")}
          </button>
        </div>
      )}
    </div>
  );
}
