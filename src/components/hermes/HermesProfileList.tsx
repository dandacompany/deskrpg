"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { getLocalizedErrorMessage } from "@/lib/i18n/error-codes";
import { useT } from "@/lib/i18n";

import {
  partitionRegistrationResults,
  toDiscoveryRows,
  toProbeStatus,
  type DiscoveryRow,
  type ProbeStatus,
} from "./discovery-rows";
import type { CharacterAppearance } from "@/game/three/office-appearance";

import { employeeDetailHref, hirePageHref } from "@/app/profiles/hire-navigation";
import RosterAvatar from "../RosterAvatar";
import HermesProfileImport from "./HermesProfileImport";
import { profileStatusLabel } from "./profile-status";
import { PROFILE_STATUS_BADGE_CLASS } from "./profile-status-style";

type HermesProfileRow = {
  id: string;
  profileName: string;
  displayName: string | null;
  lastValidationStatus: string | null;
  /** The profile is the source of truth for appearance — the editor must open from this value. */
  appearance?: CharacterAppearance | null;
};

interface HermesProfileListProps {
  gatewayId: string;
  /** Registering a profile requires gateway ownership; a shared-access user can only view + test. */
  canRegister: boolean;
  /** Opens the hire wizard immediately when arriving with `?new=1`. */
  /** Where to return to when arriving from the game screen. Carried through as-is on the hire-page link. */
  returnTo?: string | null;
  /** Called only when a profile is actually created (not on close/delete). */
  onCreated?: () => void;
}

export default function HermesProfileList({
  gatewayId,
  canRegister,
  returnTo = null,
  onCreated,
}: HermesProfileListProps) {
  const t = useT();

  const [profiles, setProfiles] = useState<HermesProfileRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [profileName, setProfileName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [token, setToken] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState("");

  const [discovery, setDiscovery] = useState<{
    available: boolean;
    optedIn: boolean;
    rows: DiscoveryRow[];
  } | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [probeStatus, setProbeStatus] = useState<ProbeStatus>("idle");
  const [registering, setRegistering] = useState(false);
  /** Profiles the last bulk registration could not add, with the error code for each. */
  const [registerFailures, setRegisterFailures] = useState<{ name: string; errorCode: string }[]>(
    [],
  );
  const [registerError, setRegisterError] = useState("");
  const [optInError, setOptInError] = useState("");
  const [optingIn, setOptingIn] = useState(false);

  const loadProfiles = useCallback(async (): Promise<HermesProfileRow[]> => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/gateways/${gatewayId}/profiles`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw data;
      const rows: HermesProfileRow[] = Array.isArray(data.profiles) ? data.profiles : [];
      setProfiles(rows);
      return rows;
    } catch (nextError) {
      setError(getLocalizedErrorMessage(t, nextError, "common.error"));
      setProfiles([]);
      return [];
    } finally {
      setLoading(false);
    }
  }, [gatewayId, t]);

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/gateways/${gatewayId}/local-discovery`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        setDiscovery({
          available: !!d.available,
          optedIn: !!d.optedIn,
          rows: toDiscoveryRows(d.candidates ?? []),
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [gatewayId]);

  const handleAdd = async () => {
    setAdding(true);
    setAddError("");
    try {
      const res = await fetch(`/api/gateways/${gatewayId}/profiles`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profileName: profileName.trim(),
          token: token.trim(),
          displayName: displayName.trim() || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw data;
      setProfileName("");
      setDisplayName("");
      setToken("");
      await loadProfiles();
      onCreated?.();
    } catch (nextError) {
      setAddError(getLocalizedErrorMessage(t, nextError, "common.error"));
    } finally {
      setAdding(false);
    }
  };

  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t("gateway.profile.title")}</h2>
        {canRegister && (
          // The wizard is owned solely by the `/profiles/new` page — the list screen only holds a link
          // (docs/standards.md "one feature, one page"). This button used to expand 4 steps above the list.
          <Link
            href={hirePageHref(gatewayId, { returnTo })}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-hover"
          >
            {t("hermes.wizard.openButton")}
          </Link>
        )}
      </div>

      {error && <p className="mb-3 text-sm text-danger">{error}</p>}

      {loading ? (
        <p className="text-sm text-text-muted">{t("common.loading")}</p>
      ) : profiles.length === 0 ? (
        <p className="text-sm text-text-muted">{t("gateway.profile.empty")}</p>
      ) : (
        <div className="mb-4 space-y-2">
          {profiles.map((profile) => {
            const { tone, key } = profileStatusLabel(profile.lastValidationStatus);
            return (
              <div key={profile.id} className="rounded-lg bg-bg px-3 py-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <RosterAvatar appearance={profile.appearance ?? null} />
                    <div>
                      <p className="font-medium text-text">
                        {profile.displayName || profile.profileName}
                      </p>
                      <p className="text-xs text-text-muted">{profile.profileName}</p>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${PROFILE_STATUS_BADGE_CLASS[tone]}`}
                    >
                      {t(key)}
                    </span>
                    {/* Editing this employee happens on a single detail page — the list never expands
                        an editor inline (docs/standards.md "one feature, one page"). */}
                    <Link
                      href={employeeDetailHref(gatewayId, profile.profileName)}
                      className="rounded bg-surface-raised px-3 py-1.5 text-xs font-semibold hover:bg-surface-raised/80"
                    >
                      {t("gateway.profile.manage")}
                    </Link>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {canRegister && (
        <HermesProfileImport
          gatewayId={gatewayId}
          onImported={() => {
            void loadProfiles();
            onCreated?.();
          }}
        />
      )}

      {canRegister ? (
        <div className="space-y-3 border-t border-border pt-4">
          {discovery?.available && !discovery.optedIn && (
            <div className="space-y-1">
              <button
                type="button"
                disabled={optingIn}
                onClick={async () => {
                  setOptingIn(true);
                  setOptInError("");
                  try {
                    const res = await fetch(`/api/gateways/${gatewayId}/local-discovery`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ action: "opt-in" }),
                    });
                    if (!res.ok) throw await res.json().catch(() => ({}));
                    const d = await fetch(`/api/gateways/${gatewayId}/local-discovery`).then((r) =>
                      r.json(),
                    );
                    setDiscovery({
                      available: !!d.available,
                      optedIn: !!d.optedIn,
                      rows: toDiscoveryRows(d.candidates ?? []),
                    });
                  } catch {
                    setOptInError(t("errors.connectionFailed"));
                  } finally {
                    setOptingIn(false);
                  }
                }}
                className="rounded-lg bg-surface-raised px-4 py-2 text-sm font-semibold hover:bg-surface-raised/80 disabled:opacity-60"
              >
                {optingIn ? t("common.loading") : t("hermes.discovery.optIn")}
              </button>
              {optInError && <p className="text-xs text-danger">{optInError}</p>}
            </div>
          )}

          {discovery?.optedIn && discovery.rows.length === 0 && (
            <p className="text-sm text-text-muted">{t("hermes.discovery.empty")}</p>
          )}

          {discovery?.optedIn && discovery.rows.length > 0 && (
            <div className="space-y-2 rounded-lg bg-bg p-3">
              {/* Without a title, this looks like an unexplained clump of checkboxes wedged between the
                  registered list and the "Add profile" form — this tells the user it came from this machine. */}
              <p className="text-sm font-semibold text-text">{t("hermes.discovery.listTitle")}</p>
              {discovery.rows.map((row) => (
                <label key={row.name} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    disabled={!row.selectable}
                    checked={selected.includes(row.name)}
                    onChange={(e) =>
                      setSelected((prev) =>
                        e.target.checked ? [...prev, row.name] : prev.filter((n) => n !== row.name),
                      )
                    }
                  />
                  <span>{row.name}</span>
                  {row.reason !== "ok" && (
                    <span className="text-xs text-text-muted">
                      {t(`hermes.discovery.reason.${row.reason}`)}
                    </span>
                  )}
                </label>
              ))}
              {registerFailures.length > 0 && (
                <ul className="space-y-1">
                  {registerFailures.map((f) => (
                    <li key={f.name} className="text-xs text-danger">
                      {f.name}: {t(`hermes.discovery.error.${f.errorCode}`)}
                    </li>
                  ))}
                </ul>
              )}
              {registerError && <p className="text-xs text-danger">{registerError}</p>}
              <button
                type="button"
                disabled={!selected.length || registering}
                onClick={async () => {
                  setRegistering(true);
                  setRegisterError("");
                  setRegisterFailures([]);
                  try {
                    const res = await fetch(`/api/gateways/${gatewayId}/local-discovery`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ profiles: selected }),
                    });
                    const data = await res.json().catch(() => ({}));
                    if (!res.ok) throw data;
                    const { nextSelected, failures } = partitionRegistrationResults(
                      Array.isArray(data.results) ? data.results : [],
                    );
                    setSelected(nextSelected);
                    setRegisterFailures(failures);
                    await loadProfiles();
                  } catch {
                    setRegisterError(t("errors.connectionFailed"));
                  } finally {
                    setRegistering(false);
                  }
                }}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-hover disabled:opacity-60"
              >
                {registering ? t("common.loading") : t("hermes.discovery.registerSelected")}
              </button>
            </div>
          )}

          {/* New employees are created through the "+ Hire new employee" wizard. This form is kept,
              collapsed, because it's the only way to register a remote profile that **already exists**
              in Hermes via token — so a first-time user doesn't mistake "Add profile" for hiring and
              get stuck hunting for a token. */}
          <details className="rounded border border-border px-3 py-2">
            <summary className="cursor-pointer text-sm font-semibold">
              {t("gateway.profile.addTitle")}
            </summary>
            <div className="mt-3 space-y-3">
              <div className="grid gap-2 sm:grid-cols-3">
                <input
                  type="text"
                  value={profileName}
                  onChange={(e) => setProfileName(e.target.value)}
                  onBlur={async () => {
                    if (!profileName.trim()) {
                      setProbeStatus("idle");
                      return;
                    }
                    const r = await fetch(`/api/gateways/${gatewayId}/profiles/probe`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ profileName }),
                    })
                      .then((x) => x.json())
                      .catch(() => ({ status: "unknown" }));
                    setProbeStatus(toProbeStatus(r.status));
                  }}
                  placeholder={t("gateway.profile.profileNamePlaceholder")}
                  className="rounded border border-border bg-bg px-3 py-2 text-text text-sm focus:outline-none focus:border-primary-light"
                />
                <input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder={t("gateway.profile.displayName")}
                  className="rounded border border-border bg-bg px-3 py-2 text-text text-sm focus:outline-none focus:border-primary-light"
                />
                <input
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder={t("gateway.profile.tokenPlaceholder")}
                  className="rounded border border-border bg-bg px-3 py-2 text-text text-sm focus:outline-none focus:border-primary-light"
                />
              </div>
              {probeStatus !== "idle" && (
                <p className="text-xs text-text-muted">{t(`hermes.probe.${probeStatus}`)}</p>
              )}
              {addError && <p className="text-sm text-danger">{addError}</p>}
              <button
                type="button"
                onClick={() => void handleAdd()}
                disabled={adding || !profileName.trim() || !token.trim()}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-hover disabled:opacity-60"
              >
                {adding ? t("common.loading") : t("gateway.profile.add")}
              </button>
            </div>
          </details>
        </div>
      ) : (
        <p className="border-t border-border pt-4 text-sm text-text-muted">
          {t("gateway.profile.ownerOnly")}
        </p>
      )}
    </section>
  );
}
