"use client";
import { useCallback, useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { getLocalizedErrorMessage } from "@/lib/i18n/error-codes";
import OpenClawPairingStatusCard, { type OpenClawPairingStatus } from "@/components/openclaw/OpenClawPairingStatusCard";

type ChannelSettingsTab = "settings" | "members" | "gateway";

interface ChannelSettingsModalProps {
  channelId: string;
  channelName: string;
  channelDescription: string | null;
  isPublic: boolean;
  inviteCode: string | null;
  initialTab?: ChannelSettingsTab;
  onClose: () => void;
  onUpdated: (data: {
    name?: string;
    description?: string | null;
    isPublic?: boolean;
    gatewayConfig?: {
      url?: string | null;
      token?: string | null;
      taskAutomation?: {
        autoProgressNudgeEnabled?: boolean;
        autoProgressNudgeMinutes?: number;
        autoProgressNudgeMax?: number;
        reportWaitSeconds?: number;
      };
    };
  }) => void;
}

interface Member {
  userId: string;
  nickname: string;
  role: string;
  joinedAt: string;
  isOnline: boolean;
}

interface GatewayConnectionState {
  status: OpenClawPairingStatus;
  requestId?: string | null;
  error?: string | null;
}

function isGatewayPairingRequired(payload: unknown): payload is {
  errorCode?: string;
  requestId?: string;
  error?: string;
} {
  if (!payload || typeof payload !== "object") return false;
  const errorCode = (payload as { errorCode?: unknown }).errorCode;
  return errorCode === "gateway_pairing_required" || errorCode === "PAIRING_REQUIRED";
}

export default function ChannelSettingsModal({
  channelId, channelName, channelDescription, isPublic, inviteCode,
  initialTab = "settings", onClose, onUpdated,
}: ChannelSettingsModalProps) {
  const t = useT();
  const [tab, setTab] = useState<ChannelSettingsTab>(initialTab);
  const [name, setName] = useState(channelName);
  const [description, setDescription] = useState(channelDescription || "");
  const [visibility, setVisibility] = useState(isPublic);
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [copied, setCopied] = useState(false);
  const [members, setMembers] = useState<Member[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [membersError, setMembersError] = useState("");
  const [kickingUserId, setKickingUserId] = useState<string | null>(null);
  const [confirmKick, setConfirmKick] = useState<Member | null>(null);

  // AI Gateway state
  const [gatewayUrl, setGatewayUrl] = useState("");
  const [gatewayToken, setGatewayToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [gatewayLoading, setGatewayLoading] = useState(false);
  const [gatewaySaving, setGatewaySaving] = useState(false);
  const [gatewayConnectionState, setGatewayConnectionState] = useState<GatewayConnectionState>({ status: "idle" });
  const [gatewayNotice, setGatewayNotice] = useState<{ success: boolean; message: string } | null>(null);
  const [gatewayError, setGatewayError] = useState("");
  const [autoProgressNudgeEnabled, setAutoProgressNudgeEnabled] = useState(false);
  const [autoProgressNudgeMinutes, setAutoProgressNudgeMinutes] = useState(5);
  const [autoProgressNudgeMax, setAutoProgressNudgeMax] = useState(5);
  const [reportWaitSeconds, setReportWaitSeconds] = useState(20);

  const loadMembers = useCallback(async () => {
    setMembersLoading(true);
    setMembersError("");
    try {
      const res = await fetch(`/api/channels/${channelId}/members`);
      if (res.ok) {
        const data = await res.json();
        setMembers(data.members || []);
      } else {
        const data = await res.json().catch(() => ({}));
        setMembersError(getLocalizedErrorMessage(t, data, "errors.failedToFetchMembers"));
      }
    } catch {
      setMembersError(t("errors.failedToFetchMembers"));
    }
    setMembersLoading(false);
  }, [channelId, t]);

  const loadGateway = useCallback(async () => {
    setGatewayLoading(true);
    setGatewayError("");
    try {
      const res = await fetch(`/api/channels/${channelId}/gateway`);
      if (res.ok) {
        const data = await res.json();
        const gc = data?.gatewayConfig;
        if (gc) {
          setGatewayUrl(gc.url || "");
          setGatewayToken(gc.token || "");
          setAutoProgressNudgeEnabled(gc.taskAutomation?.autoProgressNudgeEnabled ?? false);
          setAutoProgressNudgeMinutes(gc.taskAutomation?.autoProgressNudgeMinutes ?? 5);
          setAutoProgressNudgeMax(gc.taskAutomation?.autoProgressNudgeMax ?? 5);
          setReportWaitSeconds(gc.taskAutomation?.reportWaitSeconds ?? 20);
        }
      }
    } catch {}
    setGatewayLoading(false);
  }, [channelId]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (tab === "members") {
      timer = setTimeout(() => {
        void loadMembers();
      }, 0);
    }
    if (tab === "gateway") {
      timer = setTimeout(() => {
        void loadGateway();
      }, 0);
    }
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [tab, loadGateway, loadMembers]);

  const handleSave = async () => {
    setSaving(true);
    setSaveError("");
    setSaveSuccess(false);

    const updates: Record<string, unknown> = {};
    if (name.trim() !== channelName) updates.name = name.trim();
    if (description.trim() !== (channelDescription || "")) updates.description = description.trim() || null;
    if (visibility !== isPublic) updates.isPublic = visibility;
    if (!visibility && password) updates.password = password;

    if (Object.keys(updates).length === 0) {
      setSaving(false);
      return;
    }

    if (updates.isPublic === false && !password && isPublic) {
      setSaveError(t("settings.passwordRequiredForPrivate"));
      setSaving(false);
      return;
    }

    try {
      const res = await fetch(`/api/channels/${channelId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      if (!res.ok) {
        const data = await res.json();
        setSaveError(getLocalizedErrorMessage(t, data, "settings.failedToSave"));
      } else {
        setSaveSuccess(true);
        setPassword("");
        onUpdated(updates as { name?: string; description?: string | null; isPublic?: boolean });
        setTimeout(() => setSaveSuccess(false), 2000);
      }
    } catch {
      setSaveError(t("settings.failedToSave"));
    }
    setSaving(false);
  };

  const handleKick = async (member: Member) => {
    setKickingUserId(member.userId);
    setMembersError("");
    try {
      const res = await fetch(`/api/channels/${channelId}/members/${member.userId}`, { method: "DELETE" });
      if (res.ok) {
        setMembers((prev) => prev.filter((m) => m.userId !== member.userId));
      } else {
        const data = await res.json().catch(() => ({}));
        setMembersError(getLocalizedErrorMessage(t, data, "errors.failedToKickMember"));
      }
    } catch {
      setMembersError(t("errors.failedToKickMember"));
    }
    setKickingUserId(null);
    setConfirmKick(null);
  };

  const copyInviteCode = () => {
    if (inviteCode) {
      navigator.clipboard.writeText(inviteCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleTestConnection = async () => {
    setGatewayNotice(null);
    setGatewayConnectionState({ status: "idle" });
    setGatewayError("");
    try {
      const res = await fetch(`/api/channels/${channelId}/gateway/test`, { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        setGatewayConnectionState({ status: "connected" });
      } else {
        if (isGatewayPairingRequired(data)) {
          setGatewayConnectionState({
            status: "pairing_required",
            requestId: typeof data.requestId === "string" ? data.requestId : null,
          });
        } else {
          setGatewayConnectionState({
            status: "error",
            error: getLocalizedErrorMessage(t, data, "errors.connectionFailed"),
          });
        }
      }
    } catch {
      setGatewayConnectionState({ status: "error", error: t("errors.connectionFailed") });
    }
  };

  const handleSaveGateway = async () => {
    setGatewaySaving(true);
    setGatewayError("");
    const gatewayConfig = {
      url: gatewayUrl.trim() || null,
      token: gatewayToken.trim() || null,
      taskAutomation: {
        autoProgressNudgeEnabled,
        autoProgressNudgeMinutes: Math.max(1, Math.floor(autoProgressNudgeMinutes) || 5),
        autoProgressNudgeMax: Math.max(1, Math.floor(autoProgressNudgeMax) || 5),
        reportWaitSeconds: Math.max(5, Math.floor(reportWaitSeconds) || 20),
      },
    };
    try {
      const res = await fetch(`/api/channels/${channelId}/gateway`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(gatewayConfig),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setGatewayError(getLocalizedErrorMessage(t, data, "settings.failedToSave"));
      } else {
        const data = await res.json().catch(() => ({}));
        onUpdated({
          gatewayConfig: {
            url: data?.gatewayConfig?.url ?? gatewayConfig.url,
            token: data?.gatewayConfig?.token ?? gatewayConfig.token,
            taskAutomation: data?.gatewayConfig?.taskAutomation || gatewayConfig.taskAutomation,
          },
        });
        setGatewayNotice({ success: true, message: t("settings.saved") });
        setTimeout(() => setGatewayNotice(null), 3000);
      }
    } catch {
      setGatewayError(t("settings.failedToSave"));
    }
    setGatewaySaving(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-gray-800 rounded-xl w-full max-w-lg border border-gray-700 max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-700">
          <h2 className="text-lg font-bold text-white">{t("settings.title")}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-xl" aria-label={t("common.close")}>&times;</button>
        </div>

        <div className="flex border-b border-gray-700">
          <button onClick={() => setTab("settings")}
            className={`flex-1 py-2 text-sm font-semibold ${tab === "settings" ? "text-indigo-400 border-b-2 border-indigo-400" : "text-gray-400"}`}>
            {t("settings.general")}
          </button>
          <button onClick={() => setTab("members")}
            className={`flex-1 py-2 text-sm font-semibold ${tab === "members" ? "text-indigo-400 border-b-2 border-indigo-400" : "text-gray-400"}`}>
            {t("settings.members")}
          </button>
          <button onClick={() => setTab("gateway")}
            className={`flex-1 py-2 text-sm font-semibold ${tab === "gateway" ? "text-indigo-400 border-b-2 border-indigo-400" : "text-gray-400"}`}>
            {t("settings.gateway")}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {tab === "settings" ? (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-semibold text-gray-300 mb-1">{t("settings.channelName")}</label>
                <input type="text" value={name} onChange={(e) => setName(e.target.value)} maxLength={100}
                  className="w-full px-3 py-2 bg-gray-900 border border-gray-600 rounded text-white focus:outline-none focus:border-indigo-500" />
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-300 mb-1">{t("settings.description")}</label>
                <textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} rows={2}
                  className="w-full px-3 py-2 bg-gray-900 border border-gray-600 rounded text-white focus:outline-none focus:border-indigo-500 resize-none" />
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-300 mb-1">{t("settings.visibility")}</label>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setVisibility(true)}
                    className={`px-3 py-1 rounded text-sm ${visibility ? "bg-indigo-600 text-white" : "bg-gray-700 text-gray-400"}`}>{t("channels.public")}</button>
                  <button type="button" onClick={() => setVisibility(false)}
                    className={`px-3 py-1 rounded text-sm ${!visibility ? "bg-indigo-600 text-white" : "bg-gray-700 text-gray-400"}`}>{t("channels.private")}</button>
                </div>
                {!visibility && isPublic && <p className="text-amber-400 text-xs mt-1">{t("settings.switchToPrivateWarning")}</p>}
                {visibility && !isPublic && <p className="text-amber-400 text-xs mt-1">{t("settings.switchToPublicWarning")}</p>}
              </div>
              {!visibility && (
                <div>
                  <label className="block text-sm font-semibold text-gray-300 mb-1">{isPublic ? t("settings.setPassword") : t("settings.changePassword")}</label>
                  <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} maxLength={100}
                    placeholder={isPublic ? t("settings.passwordPlaceholderNew") : t("settings.passwordPlaceholderKeep")}
                    className="w-full px-3 py-2 bg-gray-900 border border-gray-600 rounded text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500" />
                </div>
              )}
              <div>
                <label className="block text-sm font-semibold text-gray-300 mb-1">{t("settings.inviteCode")}</label>
                <div className="flex gap-2">
                  <code className="flex-1 px-3 py-2 bg-gray-900 border border-gray-600 rounded text-amber-400 font-mono text-sm">{inviteCode || "—"}</code>
                  <button onClick={copyInviteCode} className="px-3 py-2 bg-gray-700 hover:bg-gray-600 rounded text-sm text-white">{copied ? t("game.copied") : t("common.copy")}</button>
                </div>
              </div>
              {saveError && <p className="text-red-400 text-sm">{saveError}</p>}
              {saveSuccess && <p className="text-green-400 text-sm">{t("settings.saved")}</p>}
              <button onClick={handleSave} disabled={saving}
                className="w-full px-4 py-2 bg-indigo-600 hover:bg-indigo-700 rounded font-semibold text-white disabled:opacity-50">
                {saving ? t("common.loading") : t("common.save")}
              </button>
            </div>
          ) : tab === "members" ? (
            <div>
              {membersLoading ? (
                <p className="text-gray-400 text-sm py-4 text-center">{t("settings.loadingMembers")}</p>
              ) : membersError ? (
                <p className="text-red-400 text-sm py-4 text-center">{membersError}</p>
              ) : members.length === 0 ? (
                <p className="text-gray-400 text-sm py-4 text-center">{t("settings.noMembers")}</p>
              ) : (
                <div className="space-y-2">
                  {members.map((m) => (
                    <div key={m.userId} className="flex items-center justify-between px-3 py-2 bg-gray-900 rounded">
                      <div className="flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full ${m.isOnline ? "bg-green-400" : "bg-gray-600"}`} />
                        <span className="text-white text-sm">{m.nickname}</span>
                        <span className={`text-xs px-1.5 py-0.5 rounded ${m.role === "owner" ? "bg-amber-600/30 text-amber-400" : "bg-gray-700 text-gray-400"}`}>
                          {m.role === "owner" ? t("settings.roleOwner") : t("settings.roleMember")}
                        </span>
                      </div>
                      {m.role !== "owner" && (
                        <button onClick={() => setConfirmKick(m)} disabled={kickingUserId === m.userId}
                          className="text-red-400 hover:text-red-300 text-xs px-2 py-1 disabled:opacity-50">{t("settings.kick")}</button>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {confirmKick && (
                <div className="mt-4 p-3 bg-red-900/30 border border-red-700 rounded">
                  <p className="text-sm text-white mb-2">{t("settings.kickConfirm", { name: confirmKick.nickname })}</p>
                  <div className="flex gap-2">
                    <button onClick={() => handleKick(confirmKick)} className="px-3 py-1 bg-red-600 hover:bg-red-700 rounded text-sm text-white">{t("common.confirm")}</button>
                    <button onClick={() => setConfirmKick(null)} className="px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded text-sm text-gray-300">{t("common.cancel")}</button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              {gatewayLoading ? (
                <p className="text-gray-400 text-sm py-4 text-center">{t("settings.loadingGateway")}</p>
              ) : (
                <>
                  <div>
                    <label className="block text-sm font-semibold text-gray-300 mb-1">{t("settings.gatewayUrl")}</label>
                    <input
                      type="text"
                      value={gatewayUrl}
                      onChange={(e) => setGatewayUrl(e.target.value)}
                      placeholder={t("settings.gatewayUrlPlaceholder")}
                      className="w-full px-3 py-2 bg-gray-900 border border-gray-600 rounded text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-gray-300 mb-1">{t("settings.gatewayToken")}</label>
                    <div className="flex gap-2">
                      <input
                        type={showToken ? "text" : "password"}
                        value={gatewayToken}
                        onChange={(e) => setGatewayToken(e.target.value)}
                        placeholder={t("settings.gatewayTokenPlaceholder")}
                        className="flex-1 px-3 py-2 bg-gray-900 border border-gray-600 rounded text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500"
                      />
                      <button
                        type="button"
                        onClick={() => setShowToken((v) => !v)}
                        className="px-3 py-2 bg-gray-700 hover:bg-gray-600 rounded text-sm text-gray-300"
                      >
                        {showToken ? t("common.hide") : t("common.show")}
                      </button>
                    </div>
                  </div>
                  <div className="rounded-lg border border-gray-700 bg-gray-900/60 p-3 space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-gray-200">{t("settings.taskAutomation")}</p>
                        <p className="text-xs text-gray-400 mt-1">{t("settings.autoProgressNudgeHelp")}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setAutoProgressNudgeEnabled((prev) => !prev)}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition ${
                          autoProgressNudgeEnabled ? "bg-indigo-600" : "bg-gray-700"
                        }`}
                        aria-pressed={autoProgressNudgeEnabled}
                      >
                        <span
                          className={`inline-block h-4 w-4 transform rounded-full bg-white transition ${
                            autoProgressNudgeEnabled ? "translate-x-6" : "translate-x-1"
                          }`}
                        />
                      </button>
                    </div>
                    <div className="grid grid-cols-3 gap-3">
                      <div>
                        <label className="block text-xs font-semibold text-gray-400 mb-1">
                          {t("settings.progressNudgeMinutes")}
                        </label>
                        <input
                          type="number"
                          min={1}
                          step={1}
                          value={autoProgressNudgeMinutes}
                          onChange={(e) => setAutoProgressNudgeMinutes(Number(e.target.value) || 1)}
                          disabled={!autoProgressNudgeEnabled}
                          className="w-full px-3 py-2 bg-gray-950 border border-gray-700 rounded text-white disabled:opacity-50 focus:outline-none focus:border-indigo-500"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-gray-400 mb-1">
                          {t("settings.autoProgressNudgeMax")}
                        </label>
                        <input
                          type="number"
                          min={1}
                          step={1}
                          value={autoProgressNudgeMax}
                          onChange={(e) => setAutoProgressNudgeMax(Number(e.target.value) || 1)}
                          disabled={!autoProgressNudgeEnabled}
                          className="w-full px-3 py-2 bg-gray-950 border border-gray-700 rounded text-white disabled:opacity-50 focus:outline-none focus:border-indigo-500"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-gray-400 mb-1">
                          {t("settings.reportWaitSeconds")}
                        </label>
                        <input
                          type="number"
                          min={5}
                          step={1}
                          value={reportWaitSeconds}
                          onChange={(e) => setReportWaitSeconds(Number(e.target.value) || 5)}
                          className="w-full px-3 py-2 bg-gray-950 border border-gray-700 rounded text-white focus:outline-none focus:border-indigo-500"
                        />
                      </div>
                    </div>
                  </div>
                  {gatewayConnectionState.status !== "idle" && (
                    <OpenClawPairingStatusCard
                      status={gatewayConnectionState.status}
                      requestId={gatewayConnectionState.requestId}
                      error={gatewayConnectionState.error}
                      detail={gatewayConnectionState.status === "connected" ? t("settings.connected") : undefined}
                    />
                  )}
                  {gatewayNotice && (
                    <p className={`text-sm ${gatewayNotice.success ? "text-green-400" : "text-red-400"}`}>
                      {gatewayNotice.message}
                    </p>
                  )}
                  {gatewayError && <p className="text-red-400 text-sm">{gatewayError}</p>}
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={handleTestConnection}
                      className="flex-1 px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded font-semibold text-white"
                    >
                      {t("settings.testConnection")}
                    </button>
                    <button
                      type="button"
                      onClick={handleSaveGateway}
                      disabled={gatewaySaving}
                      className="flex-1 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 rounded font-semibold text-white disabled:opacity-50"
                    >
                      {gatewaySaving ? t("common.loading") : t("common.save")}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
