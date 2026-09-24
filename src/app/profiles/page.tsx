"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowRight, RefreshCw, UsersRound } from "lucide-react";
import HermesProfileList from "@/components/hermes/HermesProfileList";
import { useT } from "@/lib/i18n";
import { getLocalizedErrorMessage } from "@/lib/i18n/error-codes";
import { backLinkTarget } from "@/app/gateways/return-target";
import { employeeDetailHref, hirePageHref } from "./hire-navigation";
import { showGatewayPicker } from "./gateway-picker-visibility";

type Gateway = {
  id: string;
  displayName: string;
  isOwner?: boolean;
};

/** NPC identity and appearance belong to a gateway profile, not a standalone character. */
export default function ProfilesPage() {
  const t = useT();
  return (
    <Suspense
      fallback={
        <div role="status" className="p-8 text-text-muted">
          {t("common.loading")}
        </div>
      }
    >
      <ProfilesPageContent />
    </Suspense>
  );
}

function ProfilesPageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const requestedGateway = searchParams.get("gateway");
  // The game screen's "새 직원" and "프로필 설정" come into this screen. After creating, send them back to where they came from
  // so the user does not have to find and enter the channel again.
  const wantsCreate = searchParams.get("new") === "1";
  const returnTo = backLinkTarget(searchParams.get("returnTo"));
  const t = useT();
  const [gateways, setGateways] = useState<Gateway[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setLoading(true);
      setError("");
      try {
        const response = await fetch("/api/gateways", { signal: controller.signal });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(getLocalizedErrorMessage(t, data));
        if (!Array.isArray(data.gateways)) throw new Error(t("common.error"));
        const available: Gateway[] = data.gateways.filter(
          (item: unknown): item is Gateway =>
            !!item &&
            typeof item === "object" &&
            typeof (item as Gateway).id === "string" &&
            typeof (item as Gateway).displayName === "string",
        );
        if (controller.signal.aborted) return;
        setGateways(available);
        setSelectedId((current) => {
          if (requestedGateway && available.some((gateway) => gateway.id === requestedGateway)) {
            return requestedGateway;
          }
          return available.some((gateway) => gateway.id === current)
            ? current
            : (available[0]?.id ?? "");
        });
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : t("common.error"));
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [attempt, requestedGateway, t]);

  const selected = gateways.find((gateway) => gateway.id === selectedId);
  // When coming back after deleting an employee on the detail screen, report here how many seats disappeared.
  const deletedNpcs = Number(searchParams.get("deletedNpcs") ?? 0);
  const lostChannels = Number(searchParams.get("channels") ?? 0);

  // `?new=1` is the old address (the form the game's "새 직원" used). Hiring is handled by its own page, so
  // pass it through — the list screen does not unfold the wizard again.
  useEffect(() => {
    if (wantsCreate && selectedId) {
      router.replace(hirePageHref(selectedId, { returnTo }));
      return;
    }
    // `?profile=` is the old address (from when the appearance editor unfolded in the list). Pass it to that employee's detail.
    const wanted = searchParams.get("profile");
    if (wanted && selectedId) router.replace(employeeDetailHref(selectedId, wanted));
  }, [returnTo, router, searchParams, selectedId, wantsCreate]);
  return (
    <div className="theme-web workspace-page">
      <div className="workspace-page-inner space-y-7">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold tracking-widest text-primary mb-2">HERMES</p>
            <h1 className="text-3xl font-bold">{t("profiles.page.title")}</h1>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-text-secondary">
              {t("profiles.page.subtitle")}
            </p>
          </div>
        </header>

        {deletedNpcs > 0 && (
          <p role="status" className="text-sm text-text-secondary">
            {t("gateway.profile.deletedNpcs", {
              npcs: String(deletedNpcs),
              channels: String(lostChannels > 0 ? lostChannels : 0),
            })}
          </p>
        )}
        {loading ? (
          <div
            role="status"
            className="rounded-2xl border border-border bg-surface p-10 text-center text-text-muted"
          >
            {t("profiles.gateways.loading")}
          </div>
        ) : error ? (
          <div className="rounded-2xl border border-border bg-surface p-8 space-y-4">
            <div role="alert">
              <h2 className="font-semibold">{t("profiles.gateways.loadFailed")}</h2>
              <p className="mt-2 text-sm text-danger">{error}</p>
            </div>
            <button
              type="button"
              onClick={() => setAttempt((value) => value + 1)}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm text-white hover:bg-primary-hover"
            >
              <RefreshCw size={15} aria-hidden="true" />
              {t("profiles.gateways.retry")}
            </button>
          </div>
        ) : gateways.length === 0 ? (
          <div className="rounded-2xl border border-border bg-surface px-6 py-14 text-center">
            <UsersRound size={36} className="mx-auto text-primary mb-4" aria-hidden="true" />
            <h2 className="text-lg font-semibold">{t("profiles.gateways.emptyTitle")}</h2>
            <p className="mx-auto mt-2 max-w-lg text-sm text-text-muted">
              {t("profiles.gateways.emptyBody")}
            </p>
            <Link
              href="/gateways"
              className="inline-flex items-center gap-2 mt-6 rounded-xl bg-primary px-5 py-3 text-sm font-semibold text-white hover:bg-primary-hover"
            >
              {t("profiles.gateways.connect")}
              <ArrowRight size={16} aria-hidden="true" />
            </Link>
          </div>
        ) : (
          <div
            className={`grid gap-5 ${showGatewayPicker(gateways.length) ? "lg:grid-cols-[260px_minmax(0,1fr)]" : ""}`}
          >
            {showGatewayPicker(gateways.length) && (
              <aside className="rounded-2xl border border-border bg-surface p-4 self-start">
                <h2 className="px-2 pb-3 text-xs font-semibold text-text-muted">
                  {t("profiles.gateways.connected")}
                </h2>
                <div className="space-y-2" role="group" aria-label={t("profiles.gateways.choose")}>
                  {gateways.map((gateway) => (
                    <button
                      type="button"
                      key={gateway.id}
                      onClick={() => setSelectedId(gateway.id)}
                      aria-pressed={gateway.id === selectedId}
                      className={`w-full rounded-xl border p-3 text-left transition-colors ${gateway.id === selectedId ? "border-primary/30 bg-primary-muted" : "border-transparent hover:bg-bg"}`}
                    >
                      <span className="block truncate text-sm font-semibold">
                        {gateway.displayName}
                      </span>
                      <span className="mt-1 block text-xs text-text-muted">
                        {gateway.isOwner === true ? t("gateways.owner") : t("gateways.shared")}
                      </span>
                    </button>
                  ))}
                </div>
              </aside>
            )}
            {selected && (
              <section
                className="min-w-0 rounded-2xl border border-border bg-surface p-5 md:p-6"
                aria-labelledby="profile-gateway-heading"
              >
                <div className="mb-5 border-b border-border-subtle pb-4">
                  <h2 id="profile-gateway-heading" className="text-lg font-semibold break-words">
                    {selected.displayName}
                  </h2>
                  <p className="mt-1 text-sm text-text-muted">
                    {selected.isOwner === true
                      ? t("profiles.gateway.ownerHint")
                      : t("profiles.gateway.sharedHint")}
                  </p>
                </div>
                <HermesProfileList
                  key={selected.id}
                  gatewayId={selected.id}
                  canRegister={selected.isOwner === true}
                  returnTo={returnTo}
                />
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
