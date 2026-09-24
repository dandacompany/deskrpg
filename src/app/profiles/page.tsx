"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowRight, RefreshCw, UsersRound } from "lucide-react";
import HermesProfileList from "@/components/hermes/HermesProfileList";
import { useLocale, useT } from "@/lib/i18n";
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
  const { locale } = useLocale();
  const t = useT();
  const ko = locale === "ko";
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
            <h1 className="text-3xl font-bold">{ko ? "직원" : "Employees"}</h1>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-text-secondary">
              {ko
                ? "직원 한 명이 Hermes 프로필 하나입니다. 여기서 직원을 등록하고 인격·외형·모델을 관리합니다. 모델 로그인은 직원마다 따로 합니다."
                : "Choose a profile from a connected gateway to manage your NPC’s name and appearance. Each NPC’s identity and appearance belong to that Hermes profile."}
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
            {ko ? "연결된 게이트웨이를 불러오는 중…" : "Loading connected gateways…"}
          </div>
        ) : error ? (
          <div className="rounded-2xl border border-border bg-surface p-8 space-y-4">
            <div role="alert">
              <h2 className="font-semibold">
                {ko ? "게이트웨이를 불러오지 못했습니다" : "Could not load gateways"}
              </h2>
              <p className="mt-2 text-sm text-danger">{error}</p>
            </div>
            <button
              type="button"
              onClick={() => setAttempt((value) => value + 1)}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm text-white hover:bg-primary-hover"
            >
              <RefreshCw size={15} aria-hidden="true" />
              {ko ? "다시 시도" : "Try again"}
            </button>
          </div>
        ) : gateways.length === 0 ? (
          <div className="rounded-2xl border border-border bg-surface px-6 py-14 text-center">
            <UsersRound size={36} className="mx-auto text-primary mb-4" aria-hidden="true" />
            <h2 className="text-lg font-semibold">
              {ko ? "먼저 게이트웨이를 연결하세요" : "Connect a gateway first"}
            </h2>
            <p className="mx-auto mt-2 max-w-lg text-sm text-text-muted">
              {ko
                ? "NPC는 연결된 Hermes 게이트웨이의 프로필에서 시작합니다. 게이트웨이를 연결하거나 공유받으면 여기에서 프로필과 외형을 관리할 수 있습니다."
                : "NPCs start with profiles on a connected Hermes gateway. Connect a gateway or obtain shared access to manage its profiles and appearances here."}
            </p>
            <Link
              href="/gateways"
              className="inline-flex items-center gap-2 mt-6 rounded-xl bg-primary px-5 py-3 text-sm font-semibold text-white hover:bg-primary-hover"
            >
              {ko ? "게이트웨이 연결하기" : "Connect gateway"}
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
                  {ko ? "연결된 게이트웨이" : "Connected gateways"}
                </h2>
                <div
                  className="space-y-2"
                  role="group"
                  aria-label={ko ? "게이트웨이 선택" : "Choose gateway"}
                >
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
                      ? ko
                        ? "이 게이트웨이의 프로필과 NPC 외형을 관리합니다."
                        : "Manage this gateway’s profiles and NPC appearances."
                      : ko
                        ? "공유받은 게이트웨이입니다. 프로필 등록과 외형 관리는 소유자가 담당합니다."
                        : "This gateway is shared with you. Its owner manages profile registration and appearance."}
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
