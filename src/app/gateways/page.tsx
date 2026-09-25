"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

import GatewaySetupWizard from "@/components/gateway/GatewaySetupWizard";
import {
  nextSelectedGatewayId,
  reloadAfterSave,
  type GatewayReloadOptions,
} from "./gateway-selection";
import GatewayOnboardingGuide from "@/components/gateway/GatewayOnboardingGuide";
import GatewayStatusCard, { type GatewayStatus } from "@/components/gateway/GatewayStatusCard";
import DiagnosticsPanel from "@/components/gateway/DiagnosticsPanel";
import { getLocalizedErrorMessage, withHeaderErrorCode } from "@/lib/i18n/error-codes";
import { useLocale, useT } from "@/lib/i18n";

import { planGatewayDelete } from "./gateway-delete-plan";
import { backLinkTarget } from "./return-target";
import { employeesHref } from "@/components/workspace-navigation";
import { describePluginVersion } from "@/lib/hermes/plugin-version-view";
import { setupCopy, setupError, setupHostError, setupStep } from "@/components/gateway/setup-copy";
import type { WorkerPropagation } from "@/lib/hermes/deskrpg-plugin-types";
import type { WorkerPluginWarning } from "@/lib/hermes/worker-plugin";
import WorkerPropagationInheritedNotice, {
  disableWorkerPropagationRequest,
} from "./WorkerPropagationInheritedNotice";
import WorkerPluginLine, { type WorkerPluginApplyResponse } from "./WorkerPluginLine";
import { enableWorkerPropagationRequest } from "./worker-propagation-request";

type GatewayRow = {
  id: string;
  displayName: string;
  baseUrl: string;
  ownerUserId?: string;
  canEditCredentials?: boolean;
  shareRole?: string | null;
  isOwner?: boolean;
  lastValidatedAt?: string | null;
  lastValidationStatus?: string | null;
  lastValidationError?: string | null;
  /** The public address of the Hermes dashboard — plugin 0.7.1 reports it, and it is sent only to the owner. */
  dashboardUrl?: string | null;
  /** The installed version seen by the last probe. `/api/gateways` serves it from the cache. */
  pluginVersion?: string | null;
  pluginStatus?: string | null;
  /** Employees whose kanban/cron artifacts do not accumulate. Sent only to the owner (`worker-plugin.ts`). */
  workerPluginWarning?: WorkerPluginWarning | null;
  /** 0.16.0 worker propagation state — only owner rows have a value (shared rows and old plugins are null). */
  workerPropagation?: WorkerPropagation | null;
};

type GatewayShare = {
  id?: string;
  userId: string;
  loginId: string;
  nickname: string | null;
  role: string;
  createdAt?: string;
};

/** The gateway connection test result. The old name was PairingState, but pairing (OpenClaw device
 * approval) is gone and all that remains is the connection test state. */
/** Channels blocking deletion. The server sends them along with 409. */
type BlockingChannel = {
  channelId: string;
  channelName: string;
  canUnbind: boolean;
  npcCount: number;
  meetingMinutesCount: number;
};

type GatewayTestState = {
  status: GatewayStatus;
  error?: string | null;
};

/**
 * Show the plugin version installed on this gateway side by side with the version the app installs.
 *
 * This line fills something that was missing — the installed version used to appear nowhere on screen, so checking
 * whether the plugin was upgraded meant reading the API directly. The value comes from the cache, and the cache can be up to an hour
 * stale (`shouldReprobePlugin`), so if it looks behind, the user is told to press "연결 테스트" to
 * check again — that button refreshes the cache after probing.
 */
function PluginVersionLine({ gateway, onUpdated }: { gateway: GatewayRow; onUpdated: () => void }) {
  const t = useT();
  const { locale } = useLocale();
  const [busyStep, setBusyStep] = useState<string | null>(null);
  const [updateError, setUpdateError] = useState("");
  // If the update inherited worker propagation turned on, say so once (the job's workerPropagationInherited).
  const [inherited, setInherited] = useState(false);
  const view = describePluginVersion({
    installed: gateway.pluginVersion,
    pluginStatus: gateway.pluginStatus,
  });

  // Updating runs commands on the host and takes long, so it runs as a job — using the same job query as the wizard.
  const runUpdate = async () => {
    setUpdateError("");
    setBusyStep("inspecting");
    try {
      const started = await fetch(`/api/gateways/${gateway.id}/plugin/update`, { method: "POST" });
      const startedBody = await started.json().catch(() => ({}));
      if (!started.ok) throw startedBody?.errorCode ?? "setup_failed";
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const res = await fetch(`/api/gateways/setup?job=${encodeURIComponent(startedBody.jobId)}`);
        const body = await res.json().catch(() => ({}));
        const job = body?.job;
        if (!res.ok || !job) throw body?.errorCode ?? "setup_failed";
        setBusyStep(job.steps?.at(-1) ?? null);
        if (job.status === "succeeded") {
          setInherited(job.workerPropagationInherited === true);
          break;
        }
        if (job.status === "failed" || job.status === "cancelled")
          throw job.error ?? "setup_failed";
      }
      onUpdated();
    } catch (code) {
      setUpdateError(setupHostError(locale, code) ?? setupError(setupCopy[locale], code));
    } finally {
      setBusyStep(null);
    }
  };

  const tone =
    view.state === "outdated"
      ? "text-npc-dark"
      : view.state === "current"
        ? "text-success"
        : "text-text-muted";

  return (
    <>
      <p className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-muted">
        <span>
          {t("gateways.pluginVersion")}:{" "}
          <span className={`font-semibold ${tone}`} data-plugin-version={view.state}>
            {view.installed ?? t("gateways.pluginVersionUnknown")}
          </span>
        </span>
        <span className="text-text-dim">·</span>
        <span>
          {t("gateways.pluginVersionPinned")}: {view.pinned}
        </span>
        {view.state === "outdated" && <span>— {t("gateways.pluginVersionOutdated")}</span>}
        {view.state === "unknown" && <span>— {t("gateways.pluginVersionRecheck")}</span>}
        {view.state === "outdated" && gateway.isOwner && (
          <button
            type="button"
            onClick={() => void runUpdate()}
            disabled={busyStep !== null}
            className="rounded-md bg-surface-raised px-2 py-0.5 text-[11px] font-medium hover:brightness-110 disabled:opacity-60"
          >
            {busyStep
              ? setupStep(setupCopy[locale], busyStep)
              : t("gateways.pluginVersionUpdateNow")}
          </button>
        )}
        {updateError && <span className="text-danger">{updateError}</span>}
      </p>
      {inherited && (
        <WorkerPropagationInheritedNotice
          turnOff={() => disableWorkerPropagationRequest(gateway.id)}
          onChanged={onUpdated}
        />
      )}
    </>
  );
}

/** The server also reports failure as 200 + errorCode (proxy convention), so branch on whether the body has `results`. */
async function applyWorkerPluginRequest(gatewayId: string): Promise<WorkerPluginApplyResponse> {
  const res = await fetch(`/api/gateways/${gatewayId}/plugin/worker-plugin`, { method: "POST" });
  const body = await res.json().catch(() => ({}));
  if (res.ok && Array.isArray(body?.results)) return { ok: true, results: body.results };
  return {
    ok: false,
    errorCode: typeof body?.errorCode === "string" ? body.errorCode : `http_${res.status}`,
  };
}

const EMPTY_TEST_STATE: GatewayTestState = { status: "idle" };

/** Show "새로 읽는 중" only when a reload takes longer than this — so short reloads do not flash. */
const REFRESH_INDICATOR_DELAY_MS = 300;

export default function GatewayManagementPage() {
  const t = useT();
  return (
    <Suspense
      fallback={
        <div className="theme-web min-h-screen flex items-center justify-center bg-bg text-text">
          {t("common.loading")}
        </div>
      }
    >
      <GatewayManagementPageInner />
    </Suspense>
  );
}

function GatewayManagementPageInner() {
  const t = useT();
  // The round trip coming from the office (channel screen) as "let's make one more persona". `gateway` says which
  // gateway to open, `new=1` whether to expand the create screen right away, and `returnTo` where to go back
  // after creating. `returnTo` is not trusted as is — safeReturnTo lets only
  // same-origin paths through (open redirect).
  const searchParams = useSearchParams();
  const requestedGatewayId = searchParams.get("gateway") ?? "";
  const autoOpenCreate = searchParams.get("new") === "1";
  const returnToParam = searchParams.get("returnTo");
  const returnTo = backLinkTarget(returnToParam);

  const [gateways, setGateways] = useState<GatewayRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedGatewayId, setSelectedGatewayId] = useState(requestedGatewayId);
  const [formMode, setFormMode] = useState<"create" | "edit">("create");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [testingGatewayId, setTestingGatewayId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  const [displayName, setDisplayName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);

  const [shares, setShares] = useState<GatewayShare[]>([]);
  const [sharesLoading, setSharesLoading] = useState(false);
  const [shareLoginId, setShareLoginId] = useState("");
  const [shareSaving, setShareSaving] = useState(false);
  const [shareError, setShareError] = useState("");

  const [testStates, setTestStates] = useState<Record<string, GatewayTestState>>({});
  const [blockingChannels, setBlockingChannels] = useState<BlockingChannel[]>([]);
  const [unbinding, setUnbinding] = useState("");
  // Sharing and diagnostics open from the top buttons (Dante's decision, 2026-09-20) — keeping them always expanded makes the screen long.
  const [panel, setPanel] = useState<"share" | "diagnostics" | null>(null);
  const [diagnosticsAvailable, setDiagnosticsAvailable] = useState(false);

  // Reload progress indicator. Shown small next to the title without swapping the screen (overlapping reloads are counted).
  const [refreshing, setRefreshing] = useState(false);
  const loadedOnce = useRef(false);
  const refreshesInFlight = useRef(0);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    },
    [],
  );

  const loadGateways = useCallback(
    async (options: GatewayReloadOptions = {}) => {
      const isRefresh = loadedOnce.current;
      if (isRefresh) {
        refreshesInFlight.current += 1;
        refreshTimer.current ??= setTimeout(() => setRefreshing(true), REFRESH_INDICATOR_DELAY_MS);
      }
      // `loading` is used only for the first load (initial value true). Setting it again on reload makes `if (loading)` turn the page
      // into the loading screen, unmounting children, and the result notices shown after an operation (the update's "계속 켭니다 [끄기]",
      // [설정에서 켜기] success) vanish along with their local state (2026-09-24 E2E measurement). Save, delete and share each have
      // their own progress indicator (saving, deleting, …).
      setError("");
      try {
        // `refreshPlugin` re-probes a cache that no longer describes the install (a host upgraded by
        // git pull), so the version line and the worker-plugin warning are not an hour behind.
        const res = await fetch("/api/gateways?refreshPlugin=1");
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw data;
        }
        const nextGateways = Array.isArray(data.gateways) ? data.gateways : [];
        setGateways(nextGateways);
        setSelectedGatewayId((current) => nextSelectedGatewayId(current, nextGateways, options));
      } catch (nextError) {
        setError(getLocalizedErrorMessage(t, nextError, "common.error"));
      } finally {
        setLoading(false);
        loadedOnce.current = true;
        if (isRefresh) {
          refreshesInFlight.current -= 1;
          if (refreshesInFlight.current === 0) {
            if (refreshTimer.current) clearTimeout(refreshTimer.current);
            refreshTimer.current = null;
            setRefreshing(false);
          }
        }
      }
    },
    [t],
  );

  useEffect(() => {
    void loadGateways();
  }, [loadGateways]);

  const selectedGateway = useMemo(
    () => gateways.find((gateway) => gateway.id === selectedGatewayId) ?? null,
    [gateways, selectedGatewayId],
  );

  useEffect(() => {
    if (!selectedGateway) {
      setFormMode("create");
      setDisplayName("");
      setBaseUrl("");
      setToken("");
      setShares([]);
      setShareError("");
      return;
    }

    setFormMode(selectedGateway.isOwner ? "edit" : "create");
    setDisplayName(selectedGateway.displayName || "");
    setBaseUrl(selectedGateway.baseUrl || "");
    setToken("");
  }, [selectedGateway]);

  const loadShares = useCallback(
    async (gatewayId: string) => {
      setSharesLoading(true);
      setShareError("");
      try {
        const res = await fetch(`/api/gateways/${gatewayId}/shares`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw data;
        }
        setShares(Array.isArray(data.shares) ? data.shares : []);
      } catch (nextError) {
        setShareError(getLocalizedErrorMessage(t, nextError, "common.error"));
        setShares([]);
      } finally {
        setSharesLoading(false);
      }
    },
    [t],
  );

  useEffect(() => {
    if (!selectedGateway?.isOwner) {
      setShares([]);
      return;
    }
    void loadShares(selectedGateway.id);
  }, [loadShares, selectedGateway]);

  const handleUpdate = async () => {
    if (!selectedGateway) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      if (token.trim()) {
        const details = await fetch(`/api/gateways/${selectedGateway.id}`);
        const data = await details.json();
        if (!details.ok) throw data;
        if (
          !window.confirm(
            t("gateways.rotateTokenConfirm", { count: data.gateway.boundChannelCount ?? 0 }),
          )
        )
          return;
      }
      const body: Record<string, unknown> = {
        displayName,
        url: baseUrl,
      };
      if (token.trim()) body.token = token.trim();

      const res = await fetch(`/api/gateways/${selectedGateway.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw data;
      }
      await loadGateways();
      setToken("");
      setNotice(t("gateways.saved"));
    } catch (nextError) {
      setError(getLocalizedErrorMessage(t, nextError, "common.error"));
    } finally {
      setSaving(false);
    }
  };

  const handleUnbindChannel = async (channel: BlockingChannel) => {
    if (!window.confirm(t("gateways.unbindConfirm", { name: channel.channelName }))) return;
    setUnbinding(channel.channelId);
    setError("");
    try {
      // Unbinding no longer deletes but puts to sleep — NPCs clock out remembering their seats
      // and minutes stay as they are. That is also why the old confirmNpcReset=1 was removed
      // (a relic still attached even though the server no longer required that confirmation).
      const res = await fetch(`/api/channels/${channel.channelId}/gateway`, {
        method: "DELETE",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw data;
      setBlockingChannels((prev) => prev.filter((c) => c.channelId !== channel.channelId));
      setNotice(t("gateways.unbound", { name: channel.channelName }));
    } catch (nextError) {
      setError(getLocalizedErrorMessage(t, nextError, "common.error"));
    } finally {
      setUnbinding("");
    }
  };

  /** Total the NPC seats and channel counts that this gateway's profiles bring along. */
  const sumGatewayUsage = async (gatewayId: string) => {
    const res = await fetch(`/api/gateways/${gatewayId}/profiles`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw data;
    const rows: { id: string }[] = Array.isArray(data.profiles) ? data.profiles : [];
    const usages = await Promise.all(
      rows.map(async (row) => {
        const usageRes = await fetch(`/api/gateways/${gatewayId}/profiles/${row.id}`);
        const usageData = await usageRes.json().catch(() => ({}));
        const usage = (usageData as { usage?: { npcs?: unknown; channels?: unknown } }).usage;
        return usageRes.ok && usage
          ? { npcs: Number(usage.npcs ?? 0), channels: Number(usage.channels ?? 0) }
          : { npcs: 0, channels: 0 };
      }),
    );
    return {
      profiles: rows.length,
      npcs: usages.reduce((sum, u) => sum + u.npcs, 0),
      channels: usages.reduce((sum, u) => sum + u.channels, 0),
    };
  };

  const handleDelete = async () => {
    if (!selectedGateway) return;
    // Deleting a gateway cascades from profiles → NPCs → tasks. A confirmation that does not say what disappears
    // and how much is not a confirmation — count the numbers first and put them in the text.
    let usage = { profiles: 0, npcs: 0, channels: 0 };
    try {
      usage = await sumGatewayUsage(selectedGateway.id);
    } catch {
      // Failing to read the numbers does not block deletion — ask with 0.
    }
    const plan = planGatewayDelete(usage);
    if (plan.blocked) {
      // This is a deletion the server will refuse with 409. Showing a confirmation would have the user agree to something that
      // will not happen — do not ask; say what must be done first.
      setError(t("gateways.deleteBlockedByChannels"));
      setNotice("");
      return;
    }
    if (
      !window.confirm(
        t("gateways.deleteConfirmWithUsage", {
          profiles: String(plan.profiles),
          npcs: String(plan.npcs),
        }),
      )
    ) {
      return;
    }
    setDeleting(true);
    setError("");
    setNotice("");
    setBlockingChannels([]);
    try {
      const res = await fetch(`/api/gateways/${selectedGateway.id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw data;
      }
      setTestStates((prev) => {
        const next = { ...prev };
        delete next[selectedGateway.id];
        return next;
      });
      await loadGateways();
      setDisplayName("");
      setBaseUrl("");
      setToken("");
      setNotice(t("gateways.deleted"));
    } catch (nextError) {
      setError(getLocalizedErrorMessage(t, nextError, "common.error"));
      // Show the list of blocking channels so they can be unbound right there — the round trip of hunting them down
      // on the channel screen was this screen's biggest friction.
      const blocked = (nextError as { channels?: BlockingChannel[] })?.channels;
      if (Array.isArray(blocked)) setBlockingChannels(blocked);
    } finally {
      setDeleting(false);
    }
  };

  const handleTest = async (gatewayId: string) => {
    setTestingGatewayId(gatewayId);
    setTestStates((prev) => ({
      ...prev,
      [gatewayId]: EMPTY_TEST_STATE,
    }));
    try {
      const res = await fetch(`/api/gateways/${gatewayId}/test`, { method: "POST" });
      // Even if the body is lost, the header code keeps the diagnosis alive (see the withHeaderErrorCode comment above).
      const data = withHeaderErrorCode(await res.json().catch(() => ({})), res.headers);
      // Probe failures come as 200 + { ok: false } (see the route's PROBE_RESULT_INIT comment).
      // Judging by res.ok would read a failure as success.
      const succeeded = res.ok && (data as { ok?: unknown } | null)?.ok !== false;
      if (succeeded) {
        setTestStates((prev) => ({
          ...prev,
          [gatewayId]: { status: "connected" },
        }));
        await loadGateways();
      } else {
        setTestStates((prev) => ({
          ...prev,
          [gatewayId]: {
            status: "error",
            error: getLocalizedErrorMessage(t, data, "errors.connectionFailed"),
          },
        }));
      }
    } catch (err) {
      // This is the case where no response came at all (the browser cut the request or the network died).
      // Showing only the fallback text makes it indistinguishable from a diagnosis the server sent, so there is no way to know
      // which layer broke — and in fact we wandered for a long time because that could not be told apart. Show the cause too.
      const detail = err instanceof Error ? err.message : String(err);
      setTestStates((prev) => ({
        ...prev,
        [gatewayId]: {
          status: "error",
          error: `${t("errors.connectionFailed")} (${detail})`,
        },
      }));
    } finally {
      setTestingGatewayId(null);
    }
  };

  const handleAddShare = async () => {
    if (!selectedGateway?.isOwner || !shareLoginId.trim()) return;
    setShareSaving(true);
    setShareError("");
    try {
      const res = await fetch(`/api/gateways/${selectedGateway.id}/shares`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ loginId: shareLoginId.trim(), role: "use" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw data;
      }
      setShareLoginId("");
      await loadShares(selectedGateway.id);
    } catch (nextError) {
      setShareError(getLocalizedErrorMessage(t, nextError, "common.error"));
    } finally {
      setShareSaving(false);
    }
  };

  const handleRemoveShare = async (userId: string) => {
    if (!selectedGateway?.isOwner) return;
    setShareSaving(true);
    setShareError("");
    try {
      const res = await fetch(`/api/gateways/${selectedGateway.id}/shares`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw data;
      }
      await loadShares(selectedGateway.id);
    } catch (nextError) {
      setShareError(getLocalizedErrorMessage(t, nextError, "common.error"));
    } finally {
      setShareSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="theme-web min-h-screen flex items-center justify-center bg-bg text-text">
        {t("common.loading")}
      </div>
    );
  }

  return (
    <div className="theme-web workspace-page">
      <div className="workspace-page-inner">
        <div className="mb-8 flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <div>
            <h1 className="flex items-center gap-3 text-3xl font-bold">
              {t("gateways.title")}
              {refreshing && (
                <span
                  role="status"
                  aria-live="polite"
                  data-gateways-refreshing=""
                  className="flex items-center gap-1 text-xs font-normal text-text-muted"
                >
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {t("gateways.refreshing")}
                </span>
              )}
            </h1>
            <p className="mt-1 text-text-muted">{t("gateways.subtitle")}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {returnTo && (
              <Link
                href={returnTo}
                className="whitespace-nowrap rounded-lg bg-surface-raised px-4 py-2 text-sm font-medium hover:bg-surface-raised/80"
              >
                {t("gateways.backToOffice")}
              </Link>
            )}
            <button
              type="button"
              onClick={() => setPanel(panel === "share" ? null : "share")}
              aria-pressed={panel === "share"}
              className="whitespace-nowrap rounded-lg bg-surface-raised px-4 py-2 text-sm font-medium hover:bg-surface-raised/80"
            >
              {t("gateways.shareTitle")}
            </button>
            {diagnosticsAvailable && (
              <button
                type="button"
                onClick={() => setPanel(panel === "diagnostics" ? null : "diagnostics")}
                aria-pressed={panel === "diagnostics"}
                className="whitespace-nowrap rounded-lg bg-surface-raised px-4 py-2 text-sm font-medium hover:bg-surface-raised/80"
              >
                {t("diagnostics.title")}
              </button>
            )}
          </div>
        </div>

        {gateways.length === 0 && <GatewayOnboardingGuide />}

        {error && (
          <div className="mb-6 rounded-lg border border-danger/40 bg-surface px-4 py-3 text-sm text-danger">
            {error}
          </div>
        )}
        {blockingChannels.length > 0 && (
          <div className="mb-6 rounded-lg border border-danger/40 bg-surface px-4 py-3 text-sm">
            <p className="mb-3 text-text-muted">{t("gateways.unbindHint")}</p>
            <ul className="space-y-2">
              {blockingChannels.map((channel) => (
                <li key={channel.channelId} className="flex items-center justify-between gap-4">
                  <span>
                    <span className="font-medium">{channel.channelName}</span>
                    <span className="ml-2 text-text-muted">
                      {t("gateways.unbindLoses", {
                        npcs: String(channel.npcCount),
                        minutes: String(channel.meetingMinutesCount),
                      })}
                    </span>
                  </span>
                  <button
                    type="button"
                    disabled={!channel.canUnbind || unbinding === channel.channelId}
                    onClick={() => void handleUnbindChannel(channel)}
                    title={channel.canUnbind ? undefined : t("gateways.unbindNotOwner")}
                    className="shrink-0 rounded-lg bg-surface-raised px-3 py-1.5 text-sm font-medium hover:bg-surface-raised/80 disabled:opacity-50"
                  >
                    {t("gateways.unbind")}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {notice && (
          <div className="mb-6 rounded-lg border border-success/30 bg-surface px-4 py-3 text-sm text-success">
            {notice}
          </div>
        )}

        <div className="grid gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
          <aside className="rounded-xl border border-border bg-surface p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-lg font-semibold">{t("gateways.listTitle")}</h2>
              <button
                type="button"
                onClick={() => {
                  setSelectedGatewayId("");
                  setFormMode("create");
                  setDisplayName("");
                  setBaseUrl("");
                  setToken("");
                  setShares([]);
                  setError("");
                  setNotice("");
                }}
                className="rounded bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:bg-primary-hover"
              >
                {t("gateways.new")}
              </button>
            </div>
            <div className="space-y-2">
              {gateways.length === 0 ? (
                <div className="rounded-lg bg-bg px-3 py-4 text-sm text-text-muted">
                  <p>{t("gateways.empty")}</p>
                  <p className="mt-1">{t("gateways.emptyHint")}</p>
                </div>
              ) : (
                gateways.map((gateway) => (
                  <button
                    key={gateway.id}
                    type="button"
                    onClick={() => setSelectedGatewayId(gateway.id)}
                    className={`w-full rounded-lg px-3 py-3 text-left transition ${
                      selectedGatewayId === gateway.id
                        ? "bg-primary-muted text-primary-light ring-1 ring-primary-light"
                        : "bg-bg hover:bg-surface-raised"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-medium">{gateway.displayName}</span>
                      <span className="text-[11px] text-text-muted">
                        {gateway.isOwner ? t("gateways.owner") : t("gateways.shared")}
                      </span>
                    </div>
                    <p className="mt-1 truncate text-xs text-text-muted">{gateway.baseUrl}</p>
                    <p className="mt-1 text-xs text-text-muted">
                      {gateway.lastValidationStatus === "valid"
                        ? t("gateways.statusValid")
                        : gateway.lastValidationStatus === "pairing_required"
                          ? t("gateways.statusPairing")
                          : gateway.lastValidationStatus
                            ? t("gateways.statusUnknown")
                            : t("gateways.statusUntested")}
                    </p>
                  </button>
                ))
              )}
            </div>
          </aside>

          <main className="space-y-6">
            {!selectedGateway ? (
              <GatewaySetupWizard
                onConnected={(gatewayId) => {
                  setSelectedGatewayId(gatewayId);
                  void loadGateways();
                }}
                onSaved={(gatewayId, pluginStatus) =>
                  void loadGateways(reloadAfterSave(gatewayId, pluginStatus))
                }
              />
            ) : (
              <section className="rounded-xl border border-border bg-surface p-5">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold">
                      {formMode === "create" ? t("gateways.createTitle") : t("gateways.editTitle")}
                    </h2>
                    <p className="mt-1 text-sm text-text-muted">
                      {formMode === "create" ? t("gateways.createHelp") : t("gateways.editHelp")}
                    </p>
                  </div>
                  {selectedGateway && (
                    <div className="flex flex-wrap items-center gap-2">
                      {selectedGateway.isOwner && selectedGateway.dashboardUrl && (
                        <a
                          href={selectedGateway.dashboardUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="whitespace-nowrap rounded-lg bg-surface-raised px-4 py-2 text-sm font-medium hover:bg-surface-raised/80"
                        >
                          {t("gateways.openDashboard")} ↗
                        </a>
                      )}
                      <button
                        type="button"
                        onClick={() => void handleTest(selectedGateway.id)}
                        disabled={testingGatewayId === selectedGateway.id}
                        className="rounded-lg bg-surface-raised px-4 py-2 text-sm font-medium hover:bg-surface-raised/80 disabled:opacity-60"
                      >
                        {testingGatewayId === selectedGateway.id
                          ? t("gateway.testing")
                          : t("gateway.testConnection")}
                      </button>
                    </div>
                  )}
                </div>

                {selectedGateway && (
                  <PluginVersionLine
                    gateway={selectedGateway}
                    onUpdated={() => void loadGateways({ autoSelect: false })}
                  />
                )}

                {selectedGateway && (
                  // Recreate by key when the gateway changes so the previous apply result is not carried over.
                  <WorkerPluginLine
                    key={selectedGateway.id}
                    warning={selectedGateway.workerPluginWarning ?? null}
                    propagation={selectedGateway.workerPropagation ?? null}
                    isOwner={selectedGateway.isOwner === true}
                    apply={() => applyWorkerPluginRequest(selectedGateway.id)}
                    onApplied={() => void loadGateways({ autoSelect: false })}
                    enablePropagation={() => enableWorkerPropagationRequest(selectedGateway.id)}
                    onRecheck={() => handleTest(selectedGateway.id)}
                  />
                )}

                <div className="grid gap-4">
                  <div>
                    <label className="mb-1 block text-sm font-semibold text-text-secondary">
                      {t("gateways.displayName")}
                    </label>
                    <input
                      type="text"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      disabled={!!selectedGateway && !selectedGateway.isOwner}
                      className="w-full rounded border border-border bg-bg px-3 py-2 text-text focus:outline-none focus:border-primary disabled:opacity-60"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-sm font-semibold text-text-secondary">
                      {t("settings.gatewayUrl")}
                    </label>
                    <input
                      type="text"
                      value={baseUrl}
                      onChange={(e) => setBaseUrl(e.target.value)}
                      disabled={!!selectedGateway && !selectedGateway.isOwner}
                      className="w-full rounded border border-border bg-bg px-3 py-2 text-text focus:outline-none focus:border-primary disabled:opacity-60"
                      placeholder={t("settings.gatewayUrlPlaceholder")}
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-sm font-semibold text-text-secondary">
                      {formMode === "create"
                        ? t("settings.gatewayToken")
                        : t("gateways.rotateToken")}
                    </label>
                    <div className="flex gap-2">
                      <input
                        type={showToken ? "text" : "password"}
                        value={token}
                        onChange={(e) => setToken(e.target.value)}
                        disabled={!!selectedGateway && !selectedGateway.isOwner}
                        className="flex-1 rounded border border-border bg-bg px-3 py-2 text-text focus:outline-none focus:border-primary disabled:opacity-60"
                        placeholder={t("settings.gatewayTokenPlaceholder")}
                      />
                      <button
                        type="button"
                        onClick={() => setShowToken((prev) => !prev)}
                        className="rounded bg-surface-raised px-3 py-2 text-sm text-text hover:bg-surface-raised/80"
                      >
                        {showToken ? t("common.hide") : t("common.show")}
                      </button>
                    </div>
                    {formMode === "edit" && (
                      <p className="mt-1 text-xs text-text-muted">
                        {t("gateways.rotateTokenHint")}
                      </p>
                    )}
                  </div>
                </div>

                {selectedGateway && testStates[selectedGateway.id] && (
                  <GatewayStatusCard
                    className="mt-4"
                    status={testStates[selectedGateway.id]?.status ?? "idle"}
                    error={testStates[selectedGateway.id]?.error}
                    detail={
                      testStates[selectedGateway.id]?.status === "connected"
                        ? t("gateways.testSuccess")
                        : undefined
                    }
                  />
                )}

                {/* Delete is not placed next to save — the irreversible button caught the eye first (2026-09-20). */}
                <div className="mt-5 flex items-center justify-between gap-3">
                  <>
                    <button
                      type="button"
                      onClick={() => void handleUpdate()}
                      disabled={
                        saving ||
                        !selectedGateway?.isOwner ||
                        !displayName.trim() ||
                        !baseUrl.trim()
                      }
                      className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-hover disabled:opacity-60"
                    >
                      {saving ? t("common.loading") : t("common.save")}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDelete()}
                      disabled={deleting || !selectedGateway?.isOwner}
                      className="ml-auto rounded-lg border border-danger/50 px-4 py-2 text-sm font-semibold text-danger hover:bg-danger/10 disabled:opacity-60"
                    >
                      {deleting ? t("common.loading") : t("common.delete")}
                    </button>
                  </>
                </div>
              </section>
            )}

            {selectedGateway && (
              // Employees (Hermes profiles) are managed in one place only, `/profiles` — this screen goes as far as "connection".
              // The same list used to appear identically on two screens, blurring where it was managed.
              <section className="rounded-xl border border-border bg-surface p-5">
                <h2 className="text-lg font-semibold">{t("gateways.employeesTitle")}</h2>
                <p className="mt-1 text-sm text-text-muted">{t("gateways.employeesHint")}</p>
                <Link
                  href={employeesHref(selectedGateway.id, {
                    create: autoOpenCreate,
                    returnTo: returnTo ?? undefined,
                  })}
                  className="mt-4 inline-block rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-hover"
                >
                  {t("gateways.employeesOpen")}
                </Link>
              </section>
            )}

            {panel === "share" && (
              <section className="rounded-xl border border-border bg-surface p-5">
                <div className="mb-4">
                  <h2 className="text-lg font-semibold">{t("gateways.shareTitle")}</h2>
                  <p className="mt-1 text-sm text-text-muted">{t("gateways.shareHelp")}</p>
                </div>

                {!selectedGateway ? (
                  <p className="text-sm text-text-muted">{t("gateways.selectGatewayFirst")}</p>
                ) : !selectedGateway.isOwner ? (
                  <p className="text-sm text-text-muted">{t("gateways.shareOwnerOnly")}</p>
                ) : (
                  <div className="space-y-4">
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={shareLoginId}
                        onChange={(e) => setShareLoginId(e.target.value)}
                        className="flex-1 rounded border border-border bg-bg px-3 py-2 text-text focus:outline-none focus:border-primary"
                        placeholder={t("gateways.shareLoginId")}
                      />
                      <button
                        type="button"
                        onClick={() => void handleAddShare()}
                        disabled={shareSaving || !shareLoginId.trim()}
                        className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-hover disabled:opacity-60"
                      >
                        {shareSaving ? t("common.loading") : t("gateways.shareAdd")}
                      </button>
                    </div>
                    {shareError && <p className="text-sm text-danger">{shareError}</p>}
                    {sharesLoading ? (
                      <p className="text-sm text-text-muted">{t("common.loading")}</p>
                    ) : shares.length === 0 ? (
                      <p className="text-sm text-text-muted">{t("gateways.shareEmpty")}</p>
                    ) : (
                      <div className="space-y-2">
                        {shares.map((share) => (
                          <div
                            key={share.userId}
                            className="flex items-center justify-between rounded-lg bg-bg px-3 py-3"
                          >
                            <div>
                              <p className="font-medium text-text">
                                {share.nickname || share.loginId}
                              </p>
                              <p className="text-xs text-text-muted">{share.loginId}</p>
                            </div>
                            <button
                              type="button"
                              onClick={() => void handleRemoveShare(share.userId)}
                              disabled={shareSaving}
                              className="rounded bg-danger px-3 py-1.5 text-xs font-semibold text-white hover:bg-danger-hover disabled:opacity-60"
                            >
                              {t("common.delete")}
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </section>
            )}

            {/* Diagnostics visible only to admins. Without permission the button does not appear either. */}
            <DiagnosticsPanel
              open={panel === "diagnostics"}
              onAvailable={setDiagnosticsAvailable}
            />
          </main>
        </div>
      </div>
    </div>
  );
}
