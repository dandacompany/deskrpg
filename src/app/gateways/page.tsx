"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";

import LocaleSwitcher from "@/components/LocaleSwitcher";
import LogoutButton from "@/components/LogoutButton";
import OpenClawPairingStatusCard, { type OpenClawPairingStatus } from "@/components/openclaw/OpenClawPairingStatusCard";
import { getLocalizedErrorMessage } from "@/lib/i18n/error-codes";
import { useT } from "@/lib/i18n";

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
};

type GatewayShare = {
  id?: string;
  userId: string;
  loginId: string;
  nickname: string | null;
  role: string;
  createdAt?: string;
};

type PairingState = {
  status: OpenClawPairingStatus;
  requestId?: string | null;
  error?: string | null;
};

const EMPTY_PAIRING_STATE: PairingState = { status: "idle" };

function isGatewayPairingRequired(payload: unknown): payload is {
  errorCode?: string;
  requestId?: string;
} {
  if (!payload || typeof payload !== "object") return false;
  const errorCode = (payload as { errorCode?: unknown }).errorCode;
  return errorCode === "gateway_pairing_required" || errorCode === "PAIRING_REQUIRED";
}

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
  const [gateways, setGateways] = useState<GatewayRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedGatewayId, setSelectedGatewayId] = useState("");
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

  const [pairingStates, setPairingStates] = useState<Record<string, PairingState>>({});

  const loadGateways = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/gateways");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw data;
      }
      const nextGateways = Array.isArray(data.gateways) ? data.gateways : [];
      setGateways(nextGateways);
      setSelectedGatewayId((current) => {
        if (current && nextGateways.some((gateway: GatewayRow) => gateway.id === current)) {
          return current;
        }
        return nextGateways[0]?.id ?? "";
      });
    } catch (nextError) {
      setError(getLocalizedErrorMessage(t, nextError, "common.error"));
    } finally {
      setLoading(false);
    }
  }, [t]);

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

  const loadShares = useCallback(async (gatewayId: string) => {
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
  }, [t]);

  useEffect(() => {
    if (!selectedGateway?.isOwner) {
      setShares([]);
      return;
    }
    void loadShares(selectedGateway.id);
  }, [loadShares, selectedGateway]);

  const handleCreate = async () => {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const res = await fetch("/api/gateways", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName, url: baseUrl, token }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw data;
      }
      await loadGateways();
      setNotice(t("gateways.saved"));
      if (data.gateway?.id) {
        setSelectedGatewayId(data.gateway.id);
      }
      setToken("");
      setFormMode("edit");
    } catch (nextError) {
      setError(getLocalizedErrorMessage(t, nextError, "common.error"));
    } finally {
      setSaving(false);
    }
  };

  const handleUpdate = async () => {
    if (!selectedGateway) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
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

  const handleDelete = async () => {
    if (!selectedGateway) return;
    if (!window.confirm(t("gateways.deleteConfirm"))) return;
    setDeleting(true);
    setError("");
    setNotice("");
    try {
      const res = await fetch(`/api/gateways/${selectedGateway.id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw data;
      }
      setPairingStates((prev) => {
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
    } finally {
      setDeleting(false);
    }
  };

  const handleTest = async (gatewayId: string) => {
    setTestingGatewayId(gatewayId);
    setPairingStates((prev) => ({
      ...prev,
      [gatewayId]: EMPTY_PAIRING_STATE,
    }));
    try {
      const res = await fetch(`/api/gateways/${gatewayId}/test`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setPairingStates((prev) => ({
          ...prev,
          [gatewayId]: { status: "connected" },
        }));
        await loadGateways();
      } else if (isGatewayPairingRequired(data)) {
        setPairingStates((prev) => ({
          ...prev,
          [gatewayId]: {
            status: "pairing_required",
            requestId: typeof data.requestId === "string" ? data.requestId : null,
          },
        }));
      } else {
        setPairingStates((prev) => ({
          ...prev,
          [gatewayId]: {
            status: "error",
            error: getLocalizedErrorMessage(t, data, "errors.connectionFailed"),
          },
        }));
      }
    } catch {
      setPairingStates((prev) => ({
        ...prev,
        [gatewayId]: { status: "error", error: t("errors.connectionFailed") },
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
    <div className="theme-web min-h-screen bg-bg px-8 py-8 text-text">
      <div className="mx-auto max-w-7xl">
        <div className="mb-8 flex items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold">{t("gateways.title")}</h1>
            <p className="mt-1 text-text-muted">{t("gateways.subtitle")}</p>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href="/channels"
              className="rounded-lg bg-surface-raised px-4 py-2 text-sm font-medium hover:bg-surface-raised/80"
            >
              {t("gateways.backToChannels")}
            </Link>
            <LogoutButton />
            <LocaleSwitcher />
          </div>
        </div>

        {error && (
          <div className="mb-6 rounded-lg border border-danger/40 bg-surface px-4 py-3 text-sm text-danger">
            {error}
          </div>
        )}
        {notice && (
          <div className="mb-6 rounded-lg border border-emerald-400/30 bg-surface px-4 py-3 text-sm text-emerald-300">
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
                  {t("gateways.empty")}
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
                  <button
                    type="button"
                    onClick={() => void handleTest(selectedGateway.id)}
                    disabled={testingGatewayId === selectedGateway.id}
                    className="rounded-lg bg-surface-raised px-4 py-2 text-sm font-medium hover:bg-surface-raised/80 disabled:opacity-60"
                  >
                    {testingGatewayId === selectedGateway.id ? t("gateway.testing") : t("gateway.testConnection")}
                  </button>
                )}
              </div>

              <div className="grid gap-4">
                <div>
                  <label className="mb-1 block text-sm font-semibold text-gray-300">{t("gateways.displayName")}</label>
                  <input
                    type="text"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    disabled={!!selectedGateway && !selectedGateway.isOwner}
                    className="w-full rounded border border-gray-600 bg-gray-900 px-3 py-2 text-white focus:outline-none focus:border-indigo-500 disabled:opacity-60"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-semibold text-gray-300">{t("settings.gatewayUrl")}</label>
                  <input
                    type="text"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    disabled={!!selectedGateway && !selectedGateway.isOwner}
                    className="w-full rounded border border-gray-600 bg-gray-900 px-3 py-2 text-white focus:outline-none focus:border-indigo-500 disabled:opacity-60"
                    placeholder={t("settings.gatewayUrlPlaceholder")}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-semibold text-gray-300">
                    {formMode === "create" ? t("settings.gatewayToken") : t("gateways.rotateToken")}
                  </label>
                  <div className="flex gap-2">
                    <input
                      type={showToken ? "text" : "password"}
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                      disabled={!!selectedGateway && !selectedGateway.isOwner}
                      className="flex-1 rounded border border-gray-600 bg-gray-900 px-3 py-2 text-white focus:outline-none focus:border-indigo-500 disabled:opacity-60"
                      placeholder={t("settings.gatewayTokenPlaceholder")}
                    />
                    <button
                      type="button"
                      onClick={() => setShowToken((prev) => !prev)}
                      className="rounded bg-surface-raised px-3 py-2 text-sm text-white hover:bg-surface-raised/80"
                    >
                      {showToken ? t("common.hide") : t("common.show")}
                    </button>
                  </div>
                  {formMode === "edit" && (
                    <p className="mt-1 text-xs text-text-muted">{t("gateways.rotateTokenHint")}</p>
                  )}
                </div>
              </div>

              {selectedGateway && pairingStates[selectedGateway.id]?.status !== "idle" && (
                <OpenClawPairingStatusCard
                  className="mt-4"
                  status={pairingStates[selectedGateway.id]?.status ?? "idle"}
                  requestId={pairingStates[selectedGateway.id]?.requestId}
                  error={pairingStates[selectedGateway.id]?.error}
                  detail={
                    pairingStates[selectedGateway.id]?.status === "connected"
                      ? t("gateways.testSuccess")
                      : undefined
                  }
                />
              )}

              <div className="mt-5 flex gap-3">
                {formMode === "create" ? (
                  <button
                    type="button"
                    onClick={() => void handleCreate()}
                    disabled={saving || !displayName.trim() || !baseUrl.trim() || !token.trim()}
                    className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-hover disabled:opacity-60"
                  >
                    {saving ? t("common.loading") : t("common.create")}
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => void handleUpdate()}
                      disabled={saving || !selectedGateway?.isOwner || !displayName.trim() || !baseUrl.trim()}
                      className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-hover disabled:opacity-60"
                    >
                      {saving ? t("common.loading") : t("common.save")}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDelete()}
                      disabled={deleting || !selectedGateway?.isOwner}
                      className="rounded-lg bg-red-700 px-4 py-2 text-sm font-semibold text-white hover:bg-red-600 disabled:opacity-60"
                    >
                      {deleting ? t("common.loading") : t("common.delete")}
                    </button>
                  </>
                )}
              </div>
            </section>

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
                      className="flex-1 rounded border border-gray-600 bg-gray-900 px-3 py-2 text-white focus:outline-none focus:border-indigo-500"
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
                        <div key={share.userId} className="flex items-center justify-between rounded-lg bg-bg px-3 py-3">
                          <div>
                            <p className="font-medium text-white">{share.nickname || share.loginId}</p>
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
          </main>
        </div>
      </div>
    </div>
  );
}
