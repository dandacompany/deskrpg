"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

import NpcHireWizard from "@/components/hermes/NpcHireWizard";
import { resolvePluginStatusFromCache, type PluginStatus } from "@/lib/hermes/plugin-capability";
import { useLocale, useT } from "@/lib/i18n";
import { backLinkTarget } from "@/app/gateways/return-target";

import { hireDoneHref, hireFinishedHref } from "../hire-navigation";

/**
 * Hiring employees — **this page is responsible for just the wizard.**
 *
 * The same wizard used to unfold inside the employee list screen, so list, creation, persona editing and model settings overlapped
 * on one screen. Only the values the wizard needs (plugin status, dashboard address, existing employee names, local discovery)
 * are read here.
 */
export default function HireEmployeePage() {
  const t = useT();
  return (
    <Suspense
      fallback={
        <div role="status" className="p-8 text-text-muted">
          {t("common.loading")}
        </div>
      }
    >
      <HireEmployeeContent />
    </Suspense>
  );
}

function HireEmployeeContent() {
  const t = useT();
  const { locale } = useLocale();
  const ko = locale === "ko";
  const router = useRouter();
  const searchParams = useSearchParams();
  const gatewayId = searchParams.get("gateway") ?? "";
  const initialProfile = searchParams.get("profile");
  const returnTo = backLinkTarget(searchParams.get("returnTo"));

  const [pluginStatus, setPluginStatus] = useState<PluginStatus>("unknown");
  const [dashboardUrl, setDashboardUrl] = useState<string | null>(null);
  const [canRegister, setCanRegister] = useState<boolean | null>(null);
  const [existingProfiles, setExistingProfiles] = useState<string[]>([]);
  const [localDiscovery, setLocalDiscovery] = useState(false);
  const [cloneDefaultProfile, setCloneDefaultProfile] = useState(false);

  const reprobePlugin = useCallback(async () => {
    try {
      const res = await fetch(`/api/gateways/${gatewayId}/test`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      const status = (data as { plugin?: { status?: unknown } })?.plugin?.status;
      return typeof status === "string" ? (status as PluginStatus) : "unknown";
    } catch {
      return "unknown" as PluginStatus;
    }
  }, [gatewayId]);

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
            supportsProfileClone?: boolean;
          } => !!row && typeof row === "object" && (row as { id?: unknown }).id === gatewayId,
        );
        if (cancelled) return;
        setCanRegister(mine?.isOwner === true);
        setDashboardUrl(typeof mine?.dashboardUrl === "string" ? mine.dashboardUrl : null);
        setCloneDefaultProfile(mine?.supportsProfileClone === true);
        const cached = resolvePluginStatusFromCache({
          pluginStatus: mine?.pluginStatus ?? null,
          pluginCheckedAt: mine?.pluginCheckedAt ?? null,
          now: new Date(),
        });
        if (!cached.needsReprobe) {
          setPluginStatus(cached.status);
          return;
        }
      } catch {
        // Proceed with a reprobe even if the list read fails.
      }
      const status = await reprobePlugin();
      if (!cancelled) setPluginStatus(status);
    })();
    return () => {
      cancelled = true;
    };
  }, [gatewayId, reprobePlugin]);

  useEffect(() => {
    if (!gatewayId) return;
    let cancelled = false;
    fetch(`/api/gateways/${gatewayId}/profiles`)
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        const rows = Array.isArray(data?.profiles) ? data.profiles : [];
        setExistingProfiles(
          rows
            .map((row: { profileName?: unknown }) =>
              typeof row.profileName === "string" ? row.profileName : "",
            )
            .filter(Boolean),
        );
      })
      .catch(() => undefined);
    fetch(`/api/gateways/${gatewayId}/local-discovery`)
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) setLocalDiscovery(!!data?.available && !!data?.optedIn);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [gatewayId]);

  if (!gatewayId) {
    return (
      <div className="theme-web min-h-screen bg-bg p-6 text-text md:p-8">
        <p className="text-sm text-danger">
          {ko ? "어느 게이트웨이의 직원인지 알 수 없습니다." : "No gateway was given."}
        </p>
        <Link href="/gateways" className="mt-3 inline-block font-semibold text-primary">
          {t("nav.gateways")} →
        </Link>
      </div>
    );
  }

  return (
    <div className="theme-web min-h-screen bg-bg p-6 text-text md:p-8">
      <div className="mx-auto max-w-4xl space-y-6">
        <header>
          <p className="mb-2 text-xs font-semibold tracking-widest text-primary">HERMES</p>
          <h1 className="text-3xl font-bold">{ko ? "새 직원" : "New employee"}</h1>
          <p className="mt-2 text-sm leading-relaxed text-text-secondary">
            {ko
              ? "직원 한 명이 Hermes 프로필 하나입니다. 이름을 정하고, 인격을 적고, 그 직원으로 모델에 로그인합니다."
              : "One employee is one Hermes profile. Name it, write its persona, then sign that employee in to a model."}
          </p>
        </header>

        {canRegister === false ? (
          <p className="text-sm text-danger">
            {ko
              ? "공유받은 게이트웨이입니다. 직원 등록은 소유자가 합니다."
              : "This gateway is shared with you; its owner registers employees."}
          </p>
        ) : (
          <NpcHireWizard
            gatewayId={gatewayId}
            pluginStatus={pluginStatus}
            existingProfiles={existingProfiles}
            initialProfile={initialProfile}
            dashboardUrl={dashboardUrl}
            localDiscovery={localDiscovery}
            cloneDefaultProfile={cloneDefaultProfile}
            canManageProviderAuth={canRegister === true}
            onDone={(result) =>
              router.push(hireFinishedHref(gatewayId, returnTo, result?.profileName ?? null))
            }
          />
        )}

        <Link
          href={hireDoneHref(gatewayId, returnTo)}
          className="inline-block text-sm font-semibold text-text-muted hover:text-text"
        >
          ← {t("nav.profiles")}
        </Link>
      </div>
    </div>
  );
}
