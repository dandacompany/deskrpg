"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";

import NpcHireWizard from "@/components/hermes/NpcHireWizard";
import { profileStatusLabel } from "@/components/hermes/profile-status";
import { PROFILE_STATUS_BADGE_CLASS } from "@/components/hermes/profile-status-style";
import { resolvePluginStatusFromCache, type PluginStatus } from "@/lib/hermes/plugin-capability";
import type { CharacterAppearance } from "@/game/three/office-appearance";
import { getLocalizedErrorMessage } from "@/lib/i18n/error-codes";
import { useLocale, useT } from "@/lib/i18n";
import { deleteConfirmParams, deletedNoticeFrom, visibleSections } from "../employee-detail-view";

type ProfileRow = {
  id: string;
  profileName: string;
  displayName: string | null;
  lastValidationStatus: string | null;
  appearance?: CharacterAppearance | null;
};

/**
 * One employee — **this page is the only screen that edits that employee.**
 *
 * Each list row used to carry persona, appearance, edit and delete buttons with editors unfolding below, so as employees
 * grew the list became a pile of editors (`docs/standards.md`'s "one feature, one page"). The list now
 * has only the name, status and a link to this screen.
 */
export default function EmployeeDetailPage() {
  const t = useT();
  return (
    <Suspense
      fallback={
        <div role="status" className="p-8 text-text-muted">
          {t("common.loading")}
        </div>
      }
    >
      <EmployeeDetailContent />
    </Suspense>
  );
}

function EmployeeDetailContent() {
  const t = useT();
  const { locale } = useLocale();
  const ko = locale === "ko";
  const router = useRouter();
  const params = useParams<{ name: string }>();
  const searchParams = useSearchParams();
  const profileName = decodeURIComponent(String(params?.name ?? ""));
  const gatewayId = searchParams.get("gateway") ?? "";
  const listHref = `/profiles?gateway=${encodeURIComponent(gatewayId)}`;

  const [profile, setProfile] = useState<ProfileRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [token, setToken] = useState("");
  const [pluginStatus, setPluginStatus] = useState<PluginStatus>("unknown");
  const [dashboardUrl, setDashboardUrl] = useState<string | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [allNames, setAllNames] = useState<string[]>([]);

  const loadProfile = useCallback(async () => {
    if (!gatewayId) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/gateways/${gatewayId}/profiles`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw data;
      const rows: ProfileRow[] = Array.isArray(data.profiles) ? data.profiles : [];
      setAllNames(rows.map((row) => row.profileName));
      const found = rows.find((row) => row.profileName === profileName) ?? null;
      setProfile(found);
      setDisplayName(found?.displayName ?? "");
    } catch (cause) {
      setError(getLocalizedErrorMessage(t, cause, "common.error"));
    } finally {
      setLoading(false);
    }
  }, [gatewayId, profileName, t]);

  useEffect(() => {
    void loadProfile();
  }, [loadProfile]);

  useEffect(() => {
    if (!gatewayId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/gateways");
        const data = await res.json().catch(() => ({}));
        const rows = Array.isArray((data as { gateways?: unknown }).gateways)
          ? (data as { gateways: unknown[] }).gateways
          : [];
        const mine = rows.find(
          (
            row,
          ): row is {
            id: string;
            isOwner?: boolean;
            pluginStatus: string | null;
            pluginCheckedAt: string | Date | null;
            dashboardUrl?: string | null;
          } => !!row && typeof row === "object" && (row as { id?: unknown }).id === gatewayId,
        );
        if (cancelled) return;
        setCanEdit(mine?.isOwner === true);
        setDashboardUrl(typeof mine?.dashboardUrl === "string" ? mine.dashboardUrl : null);
        const cached = resolvePluginStatusFromCache({
          pluginStatus: mine?.pluginStatus ?? null,
          pluginCheckedAt: mine?.pluginCheckedAt ?? null,
          now: new Date(),
        });
        setPluginStatus(cached.status);
      } catch {
        // The screen shows even if the status cannot be read — only persona and model editing are locked.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [gatewayId]);

  async function handleTest() {
    if (!profile) return;
    setTesting(true);
    setNotice("");
    try {
      const res = await fetch(`/api/gateways/${gatewayId}/profiles/${profile.id}/test`, {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));
      setProfile((prev) => (prev ? { ...prev, lastValidationStatus: data.status ?? null } : prev));
      if (data.status && data.status !== "valid" && data.error) setError(String(data.error));
    } catch {
      setError(t("errors.connectionFailed"));
    } finally {
      setTesting(false);
    }
  }

  async function handleSave() {
    if (!profile) return;
    setBusy(true);
    setError("");
    try {
      const body: Record<string, unknown> = { displayName: displayName.trim() || null };
      // Do not send an empty token — prevents the accident of wiping credentials.
      if (token.trim()) body.token = token.trim();
      const res = await fetch(`/api/gateways/${gatewayId}/profiles/${profile.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw data;
      setToken("");
      setNotice(t("gateway.profile.save"));
      await loadProfile();
    } catch (cause) {
      setError(getLocalizedErrorMessage(t, cause, "common.error"));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!profile) return;
    // Deleting a profile is firing — that employee's seats disappear from channels along with it. Count how many seats in how many channels
    // disappear **before asking**. A confirmation pressed without knowing the count is not a confirmation.
    let usage: { npcs?: unknown; channels?: unknown } | null = null;
    try {
      const res = await fetch(`/api/gateways/${gatewayId}/profiles/${profile.id}`);
      const data = await res.json().catch(() => ({}));
      if (res.ok)
        usage = (data as { usage?: { npcs?: unknown; channels?: unknown } }).usage ?? null;
    } catch {
      // Failing to read the numbers does not block deletion — ask with 0.
    }
    if (
      !window.confirm(
        t(
          "gateway.profile.deleteConfirmWithUsage",
          deleteConfirmParams(profile.profileName, usage),
        ),
      )
    ) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/gateways/${gatewayId}/profiles/${profile.id}`, {
        method: "DELETE",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw data;
      // Report how many seats disappeared on the list screen — this screen is about to go away, so showing it here
      // leaves the user no time to read (the server fields are `deletedNpcs` and `channels`).
      const notice = deletedNoticeFrom(data);
      router.push(
        notice ? `${listHref}&deletedNpcs=${notice.npcs}&channels=${notice.channels}` : listHref,
      );
    } catch (cause) {
      setError(getLocalizedErrorMessage(t, cause, "common.error"));
      setBusy(false);
    }
  }

  if (!gatewayId) {
    return (
      <div className="theme-web min-h-screen bg-bg p-6 text-text md:p-8">
        <p className="text-sm text-danger">
          {ko ? "어느 게이트웨이의 직원인지 알 수 없습니다." : "No gateway was given."}
        </p>
        <Link href="/profiles" className="mt-3 inline-block font-semibold text-primary">
          {t("nav.profiles")} →
        </Link>
      </div>
    );
  }

  const status = profileStatusLabel(profile?.lastValidationStatus ?? null);
  const sections = visibleSections(canEdit);

  return (
    <div className="theme-web min-h-screen bg-bg p-6 text-text md:p-8">
      <div className="mx-auto max-w-4xl space-y-6">
        <header className="space-y-2">
          <Link href={listHref} className="text-sm font-semibold text-text-muted hover:text-text">
            ← {t("nav.profiles")}
          </Link>
          <h1 className="text-3xl font-bold break-words">{profile?.displayName || profileName}</h1>
          <div className="flex flex-wrap items-center gap-2 text-sm text-text-muted">
            <span>{profileName}</span>
            <span
              className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${PROFILE_STATUS_BADGE_CLASS[status.tone]}`}
            >
              {t(status.key)}
            </span>
            <button
              type="button"
              onClick={() => void handleTest()}
              disabled={testing || !profile}
              className="rounded bg-surface-raised px-3 py-1.5 text-xs font-semibold hover:bg-surface-raised/80 disabled:opacity-60"
            >
              {testing ? t("gateway.testing") : t("gateway.profile.test")}
            </button>
          </div>
        </header>

        {error && <p className="text-sm text-danger">{error}</p>}
        {notice && <p className="text-sm text-success">{notice}</p>}
        {loading && !profile && <p className="text-sm text-text-muted">{t("common.loading")}</p>}
        {!loading && !profile && (
          <p className="text-sm text-danger">
            {ko ? "이 게이트웨이에 그 직원이 없습니다." : "No such employee on this gateway."}
          </p>
        )}

        {profile && (
          <>
            {/* Persona, model, login — steps ②③ of the hiring wizard are that employee's editor. */}
            {sections.includes("persona") && (
              <section className="rounded-xl border border-border bg-surface p-5">
                <NpcHireWizard
                  title={ko ? "인격·외형·AI 모델" : "Persona, appearance & AI model"}
                  gatewayId={gatewayId}
                  pluginStatus={pluginStatus}
                  existingProfiles={allNames}
                  initialProfile={profile.profileName}
                  dashboardUrl={dashboardUrl}
                  localDiscovery={false}
                  canManageProviderAuth={canEdit}
                  onDone={() => void loadProfile()}
                />
              </section>
            )}

            {sections.includes("account") && (
              <section className="space-y-2 rounded-xl border border-border bg-surface p-5">
                <h2 className="text-lg font-semibold">{t("gateway.profile.edit")}</h2>
                {/* If the display name is empty the profile name is used as is — show that fallback as the placeholder. */}
                <input
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder={profile.profileName}
                  className="w-full rounded bg-surface-raised px-3 py-2 text-sm"
                />
                <input
                  type="password"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  placeholder={t("gateway.profile.newTokenPlaceholder")}
                  className="w-full rounded bg-surface-raised px-3 py-2 text-sm"
                />
                <p className="text-xs text-text-muted">{t("gateway.profile.tokenKeepHint")}</p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void handleSave()}
                    disabled={busy}
                    className="rounded bg-primary px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                  >
                    {t("gateway.profile.save")}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDelete()}
                    disabled={busy}
                    className="rounded bg-danger/80 px-4 py-2 text-sm font-semibold text-white hover:bg-danger disabled:opacity-60"
                  >
                    {t("gateway.profile.delete")}
                  </button>
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
