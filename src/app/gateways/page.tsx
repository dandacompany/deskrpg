"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

import GatewaySetupWizard from "@/components/gateway/GatewaySetupWizard";
import { nextSelectedGatewayId } from "./gateway-selection";
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
  /** Hermes 대시보드 공개 주소 — 플러그인 0.7.1 이 알려 주고, 소유자에게만 내려온다. */
  dashboardUrl?: string | null;
  /** 마지막 프로브가 본 설치본 버전. `/api/gateways` 가 캐시에서 내려준다. */
  pluginVersion?: string | null;
  pluginStatus?: string | null;
  /** 칸반·크론 결과물이 쌓이지 않는 직원. 소유자에게만 내려온다(`worker-plugin.ts`). */
  workerPluginWarning?: WorkerPluginWarning | null;
  /** 0.16.0 워커 전파 상태 — 소유자 행에만 값이 있다(공유 행·옛 플러그인은 null). */
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

/** 게이트웨이 연결 테스트 결과. 예전 이름은 PairingState 였지만 페어링(OpenClaw 디바이스
 * 승인)은 사라졌고 남은 것은 연결 테스트 상태뿐이다. */
/** 삭제를 막고 있는 채널. 서버가 409 와 함께 실어 보낸다. */
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
 * 이 게이트웨이에 깔린 플러그인 버전과 앱이 설치하는 버전을 나란히 보여 준다.
 *
 * 없던 것을 채우는 줄이다 — 예전에는 설치본 버전이 화면 어디에도 없어서, 플러그인을
 * 올렸는지 확인하려면 API 를 직접 읽어야 했다. 값은 캐시에서 오고 캐시는 최대 1시간
 * 낡을 수 있으므로(`shouldReprobePlugin`), 뒤처져 보이면 "연결 테스트" 를 눌러 다시
 * 확인하라고 안내한다 — 그 버튼이 프로브 후 캐시를 갱신한다.
 */
function PluginVersionLine({ gateway, onUpdated }: { gateway: GatewayRow; onUpdated: () => void }) {
  const t = useT();
  const { locale } = useLocale();
  const [busyStep, setBusyStep] = useState<string | null>(null);
  const [updateError, setUpdateError] = useState("");
  // 갱신이 워커 전파를 켠 채로 이어받았으면 한 번 알린다(잡의 workerPropagationInherited).
  const [inherited, setInherited] = useState(false);
  const view = describePluginVersion({
    installed: gateway.pluginVersion,
    pluginStatus: gateway.pluginStatus,
  });

  // 갱신은 호스트에서 명령을 돌리는 긴 작업이라 잡으로 돈다 — 마법사와 같은 잡 조회를 쓴다.
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

/** 서버가 200 + errorCode 로도 실패를 말하므로(프록시 관례) 본문의 `results` 유무로 가른다. */
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

/** 재조회가 이보다 오래 걸릴 때만 "새로 읽는 중" 을 보인다 — 짧은 재조회마다 깜빡이지 않게. */
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
  // 사무실(채널 화면)에서 "인격을 하나 더 만들자"로 넘어온 왕복. `gateway` 는 어느
  // 게이트웨이를 열지, `new=1` 은 만들기 화면을 바로 펼칠지, `returnTo` 는 만든 뒤
  // 어디로 돌아갈지를 말한다. `returnTo` 는 그대로 믿지 않는다 — safeReturnTo 가
  // 같은 오리진 경로만 통과시킨다(열린 리다이렉트).
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
  // 공유·진단은 상단 버튼으로 연다(2026-09-20 단테 결정) — 늘 펼쳐 두면 화면이 길어진다.
  const [panel, setPanel] = useState<"share" | "diagnostics" | null>(null);
  const [diagnosticsAvailable, setDiagnosticsAvailable] = useState(false);

  // 재조회 진행 표시. 화면을 갈아 끼우지 않고 제목 옆에 작게 띄운다(겹친 재조회는 수를 센다).
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
    async (options: { autoSelect?: boolean } = {}) => {
      const isRefresh = loadedOnce.current;
      if (isRefresh) {
        refreshesInFlight.current += 1;
        refreshTimer.current ??= setTimeout(() => setRefreshing(true), REFRESH_INDICATOR_DELAY_MS);
      }
      // `loading` 은 첫 로딩에만 쓴다(초기값 true). 재조회 때 다시 세우면 `if (loading)` 이 페이지를
      // 로딩 화면으로 바꿔 자식을 언마운트하고, 작업 뒤에 뜨는 결과 알림(갱신의 "계속 켭니다 [끄기]",
      // [설정에서 켜기] 성공)이 지역 상태째 사라진다(2026-09-24 E2E 실측). 저장·삭제·공유는 각자의
      // 진행 표시(saving·deleting·…)가 있다.
      setError("");
      try {
        const res = await fetch("/api/gateways");
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
      // 해제는 더 이상 지우는 것이 아니라 재우는 것이다 — NPC 는 자리를 기억한 채
      // 퇴근하고 회의록은 그대로 남는다. 그래서 예전의 confirmNpcReset=1 도 없앴다
      // (서버가 그 확인을 요구하지 않는데도 붙어 있던 유물이다).
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

  /** 이 게이트웨이의 프로필들이 데리고 있는 NPC 자리·채널 수를 합산한다. */
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
    // 게이트웨이 삭제는 프로필 → NPC → 태스크까지 연쇄한다. 무엇이 얼마나
    // 사라지는지 말하지 않는 확인은 확인이 아니다 — 수치를 먼저 세어 문구에 넣는다.
    let usage = { profiles: 0, npcs: 0, channels: 0 };
    try {
      usage = await sumGatewayUsage(selectedGateway.id);
    } catch {
      // 수치를 못 읽어도 삭제를 막지는 않는다 — 0 으로 물어본다.
    }
    const plan = planGatewayDelete(usage);
    if (plan.blocked) {
      // 서버가 409 로 거절할 삭제다. 확인을 띄우면 사용자는 일어나지 않을 일에
      // 동의하게 된다 — 묻지 말고 먼저 해야 할 일을 말한다.
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
      // 막고 있는 채널을 그 자리에서 풀 수 있게 목록을 띄운다 — 채널 화면까지
      // 찾아가게 만드는 왕복이 이 화면의 가장 큰 마찰이었다.
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
      // 본문이 사라져도 헤더의 코드로 진단을 살린다(위 withHeaderErrorCode 주석 참조).
      const data = withHeaderErrorCode(await res.json().catch(() => ({})), res.headers);
      // 프로브 실패는 200 + { ok: false } 로 온다(라우트의 PROBE_RESULT_INIT 주석 참조).
      // res.ok 로 판정하면 실패를 성공으로 읽는다.
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
      // 여기는 응답이 아예 오지 않은 경우다(브라우저가 요청을 끊었거나 네트워크가 죽었거나).
      // 폴백 문구만 띄우면 서버가 보낸 진단과 구분되지 않아, 어느 층에서 끊겼는지 알 수
      // 없다 — 실제로 그 구분이 안 돼 한참을 헤맸다. 원인을 함께 보여준다.
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
          <div className="mb-6 rounded-lg border border-emerald-400/30 bg-surface px-4 py-3 text-sm text-emerald-700">
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
                onSaved={() => void loadGateways({ autoSelect: false })}
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
                  // 게이트웨이를 바꾸면 이전 적용 결과를 들고 가지 않도록 key 로 새로 만든다.
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

                {/* 삭제는 저장과 붙여 두지 않는다 — 되돌릴 수 없는 버튼이 먼저 눈에 들었다(2026-09-20). */}
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
              // 직원(Hermes 프로필) 관리는 `/profiles` 한 곳에서만 한다 — 이 화면은 "연결" 까지다.
              // 예전에는 같은 목록이 두 화면에 똑같이 떠서 어디서 관리하는지가 흐려졌다.
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
                              className="rounded bg-red-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-600 disabled:opacity-60"
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

            {/* 관리자에게만 보이는 진단. 권한이 없으면 버튼도 나오지 않는다. */}
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
