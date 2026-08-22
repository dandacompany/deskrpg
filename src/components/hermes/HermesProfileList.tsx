"use client";

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
import { profileStatusLabel } from "./profile-status";
import { PROFILE_STATUS_BADGE_CLASS } from "./profile-status-style";

type HermesProfileRow = {
  id: string;
  profileName: string;
  displayName: string | null;
  lastValidationStatus: string | null;
};

interface HermesProfileListProps {
  gatewayId: string;
  /** Registering a profile requires gateway ownership; a shared-access user can only view + test. */
  canRegister: boolean;
}

export default function HermesProfileList({ gatewayId, canRegister }: HermesProfileListProps) {
  const t = useT();

  const [profiles, setProfiles] = useState<HermesProfileRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [profileName, setProfileName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [token, setToken] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState("");

  const [testingId, setTestingId] = useState<string | null>(null);
  const [testErrors, setTestErrors] = useState<Record<string, string>>({});

  const [discovery, setDiscovery] = useState<{
    available: boolean;
    optedIn: boolean;
    rows: DiscoveryRow[];
  } | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [probeStatus, setProbeStatus] = useState<ProbeStatus>("idle");
  const [registering, setRegistering] = useState(false);
  const [registerFailures, setRegisterFailures] = useState<{ name: string; errorCode: string }[]>(
    [],
  );
  const [registerError, setRegisterError] = useState("");
  const [optInError, setOptInError] = useState("");
  const [optingIn, setOptingIn] = useState(false);

  const loadProfiles = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/gateways/${gatewayId}/profiles`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw data;
      setProfiles(Array.isArray(data.profiles) ? data.profiles : []);
    } catch (nextError) {
      setError(getLocalizedErrorMessage(t, nextError, "common.error"));
      setProfiles([]);
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
    } catch (nextError) {
      setAddError(getLocalizedErrorMessage(t, nextError, "common.error"));
    } finally {
      setAdding(false);
    }
  };

  const handleTest = async (profileId: string) => {
    setTestingId(profileId);
    setTestErrors((prev) => {
      const next = { ...prev };
      delete next[profileId];
      return next;
    });
    try {
      const res = await fetch(`/api/gateways/${gatewayId}/profiles/${profileId}/test`, {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));
      setProfiles((prev) =>
        prev.map((profile) =>
          profile.id === profileId
            ? { ...profile, lastValidationStatus: data.status ?? null }
            : profile,
        ),
      );
      if (data.status && data.status !== "valid" && data.error) {
        setTestErrors((prev) => ({ ...prev, [profileId]: String(data.error) }));
      }
    } catch {
      setTestErrors((prev) => ({ ...prev, [profileId]: t("errors.connectionFailed") }));
    } finally {
      setTestingId(null);
    }
  };

  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <div className="mb-4">
        <h2 className="text-lg font-semibold">{t("gateway.profile.title")}</h2>
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
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="font-medium text-white">
                      {profile.displayName || profile.profileName}
                    </p>
                    <p className="text-xs text-text-muted">{profile.profileName}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span
                      className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${PROFILE_STATUS_BADGE_CLASS[tone]}`}
                    >
                      {t(key)}
                    </span>
                    <button
                      type="button"
                      onClick={() => void handleTest(profile.id)}
                      disabled={testingId === profile.id}
                      className="rounded bg-surface-raised px-3 py-1.5 text-xs font-semibold hover:bg-surface-raised/80 disabled:opacity-60"
                    >
                      {testingId === profile.id ? t("gateway.testing") : t("gateway.profile.test")}
                    </button>
                  </div>
                </div>
                {testErrors[profile.id] && (
                  <p className="mt-1 text-xs text-danger">{testErrors[profile.id]}</p>
                )}
              </div>
            );
          })}
        </div>
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
              {/* 제목이 없으면 등록 목록과 "프로필 추가" 폼 사이에 정체불명의
                  체크박스 뭉치로 보인다 — 이게 이 머신에서 찾아온 것임을 말해 준다. */}
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

          <h3 className="text-sm font-semibold">{t("gateway.profile.addTitle")}</h3>
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
              className="rounded border border-gray-600 bg-gray-900 px-3 py-2 text-white text-sm focus:outline-none focus:border-indigo-500"
            />
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={t("gateway.profile.displayName")}
              className="rounded border border-gray-600 bg-gray-900 px-3 py-2 text-white text-sm focus:outline-none focus:border-indigo-500"
            />
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={t("gateway.profile.tokenPlaceholder")}
              className="rounded border border-gray-600 bg-gray-900 px-3 py-2 text-white text-sm focus:outline-none focus:border-indigo-500"
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
      ) : (
        <p className="border-t border-border pt-4 text-sm text-text-muted">
          {t("gateway.profile.ownerOnly")}
        </p>
      )}
    </section>
  );
}
