"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

import { useT } from "@/lib/i18n";
import { getLocalizedErrorMessage } from "@/lib/i18n/error-codes";

/**
 * Sharing one gateway — `/gateways/[id]/share`. It used to be a panel on `/gateways`, which made
 * the connection screen carry list, wizard, edit form, sharing and diagnostics at once ("one
 * feature, one page"). Only the owner manages shares; the server enforces it too, this screen
 * just doesn't offer what would be refused.
 */
type GatewayShare = {
  userId: string;
  loginId: string;
  nickname: string | null;
  role: string;
};

type GatewayInfo = { displayName: string; isOwner: boolean };

export function gatewayHref(gatewayId: string): string {
  return `/gateways?gateway=${encodeURIComponent(gatewayId)}`;
}

export default function GatewayShares({ gatewayId }: { gatewayId: string }) {
  const t = useT();
  const [gateway, setGateway] = useState<GatewayInfo | null>(null);
  const [loadError, setLoadError] = useState("");
  const [shares, setShares] = useState<GatewayShare[]>([]);
  const [sharesLoading, setSharesLoading] = useState(false);
  const [loginId, setLoginId] = useState("");
  const [saving, setSaving] = useState(false);
  const [shareError, setShareError] = useState("");

  const loadShares = useCallback(async () => {
    setSharesLoading(true);
    setShareError("");
    try {
      const res = await fetch(`/api/gateways/${gatewayId}/shares`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw data;
      setShares(Array.isArray(data.shares) ? data.shares : []);
    } catch (nextError) {
      setShareError(getLocalizedErrorMessage(t, nextError, "common.error"));
      setShares([]);
    } finally {
      setSharesLoading(false);
    }
  }, [gatewayId, t]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch(`/api/gateways/${gatewayId}`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw data;
        if (!alive) return;
        const row = data.gateway ?? {};
        setGateway({ displayName: String(row.displayName ?? ""), isOwner: row.isOwner === true });
        if (row.isOwner === true) void loadShares();
      } catch (nextError) {
        if (alive) setLoadError(getLocalizedErrorMessage(t, nextError, "common.error"));
      }
    })();
    return () => {
      alive = false;
    };
  }, [gatewayId, loadShares, t]);

  const mutate = async (method: "POST" | "DELETE", body: Record<string, string>) => {
    setSaving(true);
    setShareError("");
    try {
      const res = await fetch(`/api/gateways/${gatewayId}/shares`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw data;
      if (method === "POST") setLoginId("");
      await loadShares();
    } catch (nextError) {
      setShareError(getLocalizedErrorMessage(t, nextError, "common.error"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="theme-web workspace-page">
      <div className="workspace-page-inner max-w-3xl">
        <Link
          href={gatewayHref(gatewayId)}
          data-back-to-gateways=""
          className="text-sm text-text-muted hover:text-text"
        >
          ← {t("gateways.backToGateways")}
        </Link>
        <h1 className="mt-3 text-3xl font-bold">{t("gateways.shareTitle")}</h1>
        {gateway && <p className="mt-1 text-text-muted">{gateway.displayName}</p>}
        <p className="mt-1 text-sm text-text-muted">{t("gateways.shareHelp")}</p>

        <section className="mt-6 rounded-xl border border-border bg-surface p-5">
          {loadError ? (
            <p className="text-sm text-danger">{loadError}</p>
          ) : !gateway ? (
            <p className="text-sm text-text-muted">{t("common.loading")}</p>
          ) : !gateway.isOwner ? (
            <p className="text-sm text-text-muted">{t("gateways.shareOwnerOnly")}</p>
          ) : (
            <div className="space-y-4">
              <div className="flex gap-2">
                <input
                  type="text"
                  data-share-login-id=""
                  value={loginId}
                  onChange={(e) => setLoginId(e.target.value)}
                  className="flex-1 rounded border border-border bg-bg px-3 py-2 text-text focus:outline-none focus:border-primary"
                  placeholder={t("gateways.shareLoginId")}
                />
                <button
                  type="button"
                  data-share-add=""
                  onClick={() => void mutate("POST", { loginId: loginId.trim(), role: "use" })}
                  disabled={saving || !loginId.trim()}
                  className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-hover disabled:opacity-60"
                >
                  {saving ? t("common.loading") : t("gateways.shareAdd")}
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
                        <p className="font-medium text-text">{share.nickname || share.loginId}</p>
                        <p className="text-xs text-text-muted">{share.loginId}</p>
                      </div>
                      <button
                        type="button"
                        data-share-remove=""
                        onClick={() => void mutate("DELETE", { userId: share.userId })}
                        disabled={saving}
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
      </div>
    </div>
  );
}
