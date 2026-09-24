"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

import NpcHireWizard from "@/components/hermes/NpcHireWizard";
import { resolvePluginStatusFromCache, type PluginStatus } from "@/lib/hermes/plugin-capability";
import { useT } from "@/lib/i18n";
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
        <p className="text-sm text-danger">{t("profiles.noGateway")}</p>
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
          <h1 className="text-3xl font-bold">{t("profiles.new.title")}</h1>
          <p className="mt-2 text-sm leading-relaxed text-text-secondary">
            {t("profiles.new.subtitle")}
          </p>
        </header>

        {canRegister === false ? (
          <p className="text-sm text-danger">{t("profiles.new.sharedGateway")}</p>
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
