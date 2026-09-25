"use client";
import { useEffect, useMemo, useState } from "react";
import { Plug, Settings2, ShieldCheck } from "lucide-react";

import { useT } from "@/lib/i18n";
import { MCP_ADMIN_MIN_VERSION } from "@/lib/hermes/deskrpg-plugin-types";

import type { ConnectorListView } from "./connector-types";
import { cardState, type CardState } from "./connector-view-model";
import { ConnectorsApiError, createConnectorsApi, type ConnectorsApi } from "./connectors-api";

export type NpcConnectorsTabProps = {
  channelId: string;
  npcId: string;
  /** Opens the manager modal; with `serverName`, opens it with that server selected. */
  onOpenManager(serverName?: string): void;
  /** Opens the unattended run policy modal (owner only). */
  onOpenPolicy?(): void;
  api?: ConnectorsApi;
};

/** Status dot colour per card state — success, danger, or neutral (no new tokens). */
export const STATE_DOT: Record<CardState, string> = {
  connected: "bg-success",
  checking: "bg-primary",
  needsAuth: "bg-danger",
  error: "bg-danger",
  off: "bg-border",
  unchecked: "bg-border",
};

export function agoMinutes(at: string, now = Date.now()): number {
  return Math.max(0, Math.round((now - Date.parse(at)) / 60_000));
}

/**
 * The [Connectors] tab of the NPC chat window — the MCP servers this NPC (Hermes profile)
 * can use. Members see a read-only list; the gateway owner gets the manage button and a
 * per-card shortcut into the manager. All editing happens in the manager modal.
 */
export default function NpcConnectorsTab({
  channelId,
  npcId,
  onOpenManager,
  onOpenPolicy,
  api: injected,
}: NpcConnectorsTabProps) {
  const t = useT();
  const api = useMemo(
    () => injected ?? createConnectorsApi(channelId, npcId),
    [injected, channelId, npcId],
  );
  // The result remembers which api (NPC) it belongs to, so after switching NPCs the previous
  // list is dropped during render instead of being reset in an effect.
  const [result, setResult] = useState<{
    api: ConnectorsApi;
    view: ConnectorListView | null;
    error: Error | null;
  } | null>(null);
  // A late response for the previous NPC is discarded — the effect's cleanup marks it stale.
  useEffect(() => {
    let stale = false;
    api.list().then(
      (view) => {
        if (!stale) setResult({ api, view, error: null });
      },
      (e: unknown) => {
        if (!stale) {
          setResult({ api, view: null, error: e instanceof Error ? e : new Error(String(e)) });
        }
      },
    );
    return () => {
      stale = true;
    };
  }, [api]);

  const current = result?.api === api ? result : null;
  const view = current?.view ?? null;
  const error = current?.error ?? null;

  if (error instanceof ConnectorsApiError && error.code === "plugin_upgrade_required") {
    return (
      <p data-testid="connectors-upgrade-required" className="p-3 text-sm text-text-muted">
        {t("connectors.upgradeRequired", { version: MCP_ADMIN_MIN_VERSION })}
      </p>
    );
  }
  if (error) {
    const gateway = error instanceof ConnectorsApiError && error.status === 409;
    return (
      <p className="p-3 text-sm text-danger">
        {t(gateway ? "connectors.gatewayDisconnected" : "connectors.error.load")}
      </p>
    );
  }
  if (!view) return <p className="p-3 text-sm text-text-dim">{t("connectors.loading")}</p>;

  return (
    <div data-testid="npc-connectors-tab" className="flex h-full flex-col text-sm">
      <div className="flex items-center gap-2 border-b border-border p-2">
        <span className="flex-1 text-xs text-text-muted">
          {t("connectors.count", { n: view.servers.length })}
        </span>
        {view.canManage && onOpenPolicy && (
          <button
            type="button"
            data-testid="connectors-open-policy"
            onClick={onOpenPolicy}
            className="flex items-center gap-1 rounded px-2 py-1 text-xs text-primary hover:bg-surface-raised"
          >
            <ShieldCheck className="h-3.5 w-3.5" />
            {t("approvalPolicy.open")}
          </button>
        )}
        {view.canManage && (
          <button
            type="button"
            data-testid="connectors-open-manager"
            onClick={() => onOpenManager()}
            className="flex items-center gap-1 rounded px-2 py-1 text-xs text-primary hover:bg-surface-raised"
          >
            <Settings2 className="h-3.5 w-3.5" />
            {t("connectors.openManager")}
          </button>
        )}
      </div>
      {view.sharedChannelCount > 0 && (
        <p data-testid="connectors-shared-warning" className="px-3 py-2 text-xs text-text-muted">
          {t("connectors.sharedWarning", { n: view.sharedChannelCount })}
        </p>
      )}
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {view.servers.length === 0 && <p className="p-3 text-text-dim">{t("connectors.empty")}</p>}
        {view.servers.map((s) => {
          const state = cardState(s, false);
          return (
            <div key={s.name} className="mt-1 rounded border border-border px-2 py-1.5">
              <div className="flex items-center gap-2">
                <span
                  data-testid={`connector-state-${s.name}`}
                  data-state={state}
                  className={`h-2 w-2 flex-shrink-0 rounded-full ${STATE_DOT[state]}`}
                />
                <Plug className="h-3.5 w-3.5 flex-shrink-0 text-text-muted" />
                <span className="min-w-0 truncate font-medium text-text">{s.name}</span>
                <span className="text-[10px] text-text-muted">
                  {t(`connectors.kind.${s.kind}`)}
                </span>
                {s.tools && (
                  <span className="ml-auto text-xs text-text-muted">
                    {t("connectors.toolCount", { on: s.tools.enabled, total: s.tools.total })}
                  </span>
                )}
              </div>
              <div className="mt-0.5 flex items-center gap-2 pl-4 text-[11px] text-text-dim">
                <span>{t(`connectors.state.${state}`)}</span>
                {s.lastCheck && (
                  <span>{t("connectors.checkedAgo", { n: agoMinutes(s.lastCheck.at) })}</span>
                )}
                {view.canManage && state !== "connected" && state !== "checking" && (
                  <button
                    type="button"
                    data-testid={`connector-action-${s.name}`}
                    onClick={() => onOpenManager(s.name)}
                    className="ml-auto text-primary"
                  >
                    {t(`connectors.action.${state}`)}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
