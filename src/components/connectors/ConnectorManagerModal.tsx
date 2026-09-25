"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plug, Plus, X } from "lucide-react";

import { useT } from "@/lib/i18n";
import type { McpServerDetail, McpTool } from "@/lib/hermes/plugin-client-types";

import ConnectorAddPane from "./ConnectorAddPane";
import ConnectorCopyPane from "./ConnectorCopyPane";
import ConnectorOAuthStep from "./ConnectorOAuthStep";
import { STATE_DOT } from "./NpcConnectorsTab";
import { connectorErrorText } from "./connector-error-text";
import type { ConnectorListView } from "./connector-types";
import { cardState, quickAction, staleServers, type QuickAction } from "./connector-view-model";
import { ConnectorsApiError, createConnectorsApi, type ConnectorsApi } from "./connectors-api";
import { CONNECTOR_POLL_INTERVAL_MS, CONNECTOR_TEST_TIMEOUT_MS } from "./use-connector-job";

type Pane = "detail" | "add" | "oauth" | "copy";
type Section = "overview" | "tools" | "auth";
type ToolsState =
  | { status: "idle" | "loading" | "unknown" }
  | { status: "ready"; tools: McpTool[]; revision: string }
  | { status: "error"; message: string };

export type ConnectorManagerModalProps = {
  channelId: string;
  npcId: string;
  npcName: string;
  onClose(): void;
  /** Server to preselect — comes from a card action on the chat window's [Connectors] tab. */
  initialServer?: string;
  api?: ConnectorsApi;
  /** Other active NPCs of this channel, for [Copy to other NPCs]. */
  copyTargets: { npcId: string; name: string }[];
  /** Job poll interval; tests pass 0. */
  pollIntervalMs?: number;
};

/** Where the manager goes after [Add] saves a server — an OAuth server still missing its token goes straight to sign-in. */
export function paneAfterAdd(view: ConnectorListView | null, name: string): "detail" | "oauth" {
  const added = view?.servers.find((s) => s.name === name);
  return added?.auth === "oauth" && !added.oauthTokenPresent ? "oauth" : "detail";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function Switch(props: {
  on: boolean;
  label: string;
  action: string;
  disabled?: boolean;
  onToggle(): void;
}) {
  return (
    <button
      type="button"
      role="switch"
      data-action={props.action}
      aria-checked={props.on}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={props.onToggle}
      className={`relative h-4 w-7 flex-shrink-0 rounded-full transition-colors disabled:opacity-50 ${
        props.on ? "bg-primary" : "bg-border"
      }`}
    >
      <span
        className={`absolute top-0.5 h-3 w-3 rounded-full bg-surface transition-all ${
          props.on ? "left-3.5" : "left-0.5"
        }`}
      />
    </button>
  );
}

/**
 * Connector (MCP server) manager for one NPC. Left: the server list; right: the selected
 * server's overview · tools · sign-in, or the add / OAuth / copy panes. Members can open it
 * read-only; every change control is rendered for `canManage` (gateway owner) only, and the
 * server enforces the same with 403. Writes change Hermes config, so each success raises a
 * banner whose [Apply] reloads MCP on the gateway.
 */
export default function ConnectorManagerModal({
  channelId,
  npcId,
  npcName,
  onClose,
  initialServer,
  api: injected,
  copyTargets,
  pollIntervalMs = CONNECTOR_POLL_INTERVAL_MS,
}: ConnectorManagerModalProps) {
  const t = useT();
  const api = useMemo(
    () => injected ?? createConnectorsApi(channelId, npcId),
    [injected, channelId, npcId],
  );
  const [view, setView] = useState<ConnectorListView | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<McpServerDetail | null>(null);
  const [tools, setTools] = useState<ToolsState>({ status: "idle" });
  const [toolQuery, setToolQuery] = useState("");
  const [section, setSection] = useState<Section>("overview");
  const [pane, setPane] = useState<Pane>("detail");
  const [dirty, setDirty] = useState(false);
  const [reloadNote, setReloadNote] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [busyTest, setBusyTest] = useState<ReadonlySet<string>>(new Set());
  const [secretInputs, setSecretInputs] = useState<Record<string, string>>({});
  const [deleteText, setDeleteText] = useState<string | null>(null);

  // Bumped whenever the NPC changes or the modal closes — every async result checks it, so a
  // late response for the previous NPC never lands on the new one and polling loops stop.
  const epoch = useRef(0);
  const listSeq = useRef(0);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selected;

  const load = useCallback(async (): Promise<ConnectorListView | null> => {
    const e = epoch.current;
    const seq = ++listSeq.current;
    try {
      const next = await api.list();
      if (e !== epoch.current || seq !== listSeq.current) return null;
      setView(next);
      setLoadError(null);
      return next;
    } catch (err) {
      if (e !== epoch.current || seq !== listSeq.current) return null;
      setLoadError(err);
      return null;
    }
  }, [api]);

  const loadTools = useCallback(
    async (name: string) => {
      const e = epoch.current;
      const current = () => e === epoch.current && selectedRef.current === name;
      try {
        const r = await api.tools(name);
        if (current()) setTools({ status: "ready", tools: r.tools, revision: r.revision });
      } catch (err) {
        if (!current()) return;
        setTools(
          err instanceof ConnectorsApiError && err.code === "tools_unknown"
            ? { status: "unknown" }
            : { status: "error", message: connectorErrorText(t, err) },
        );
      }
    },
    [api, t],
  );

  /** Starts a connection test and polls its job (2s, up to 90s), then refreshes the list and tools. */
  const runTest = useCallback(
    async (name: string, silent = false) => {
      const e = epoch.current;
      setBusyTest((prev) => new Set(prev).add(name));
      try {
        const { jobId } = await api.test(name);
        const deadline = Date.now() + CONNECTOR_TEST_TIMEOUT_MS;
        for (;;) {
          await sleep(pollIntervalMs);
          if (e !== epoch.current) return;
          const job = await api.job(jobId);
          if (job.state !== "running") break;
          if (Date.now() > deadline) throw new ConnectorsApiError(0, "timeout", "");
        }
        if (e !== epoch.current) return;
        await load();
        if (selectedRef.current === name) await loadTools(name);
      } catch (err) {
        if (!silent && e === epoch.current) setActionError(connectorErrorText(t, err));
      } finally {
        if (e === epoch.current) {
          setBusyTest((prev) => {
            const next = new Set(prev);
            next.delete(name);
            return next;
          });
        }
      }
    },
    [api, load, loadTools, pollIntervalMs, t],
  );

  // Open (or switch NPC): load the list, pick a server, then re-check stale servers one by one.
  useEffect(() => {
    const e = ++epoch.current;
    setView(null);
    setSelected(null);
    setPane("detail");
    setDirty(false);
    setReloadNote(null);
    setActionError(null);
    setBusyTest(new Set());
    void (async () => {
      const v = await load();
      if (!v || e !== epoch.current) return;
      const names = v.servers.map((s) => s.name);
      setSelected(
        initialServer && names.includes(initialServer) ? initialServer : (names[0] ?? null),
      );
      if (!v.canManage) return;
      for (const name of staleServers(v.servers, Date.now())) {
        if (e !== epoch.current) return;
        await runTest(name, true);
      }
    })();
    return () => {
      epoch.current += 1;
    };
    // initialServer is only read when the list first arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  const canManage = view?.canManage ?? false;

  // Selected server changed: fetch the owner-only detail and reset per-server inputs.
  useEffect(() => {
    setDetail(null);
    setSecretInputs({});
    setDeleteText(null);
    setConflict(false);
    setTools({ status: "idle" });
    if (!selected || !canManage) return;
    const e = epoch.current;
    const name = selected;
    api.detail(name).then(
      (d) => {
        if (e === epoch.current && selectedRef.current === name) setDetail(d);
      },
      (err) => {
        if (e === epoch.current && selectedRef.current === name)
          setActionError(connectorErrorText(t, err));
      },
    );
  }, [selected, canManage, api, t]);

  // The tool list is read when the [Tools] section is showing.
  useEffect(() => {
    if (section !== "tools" || !selected || pane !== "detail") return;
    setTools({ status: "loading" });
    void loadTools(selected);
  }, [section, selected, pane, loadTools]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const markDirty = () => {
    setDirty(true);
    setReloadNote(null);
  };

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setActionError(null);
    setConflict(false);
    try {
      await action();
    } catch (e) {
      setActionError(connectorErrorText(t, e));
      setConflict(e instanceof ConnectorsApiError && e.code === "revision_conflict");
    } finally {
      setBusy(false);
    }
  };

  const row = view?.servers.find((s) => s.name === selected) ?? null;

  const saveTools = (include: string[]) =>
    run(async () => {
      if (!row || tools.status !== "ready") return;
      await api.setTools(row.name, { include, baseRevision: tools.revision });
      markDirty();
      await load();
      await loadTools(row.name);
    });

  const reloadTools = () => {
    if (!row) return;
    setConflict(false);
    setActionError(null);
    void load();
    void loadTools(row.name);
  };

  const apply = () =>
    run(async () => {
      try {
        const r = await api.reload();
        setDirty(false);
        setReloadNote(
          t(r.agentsRefreshed ? "connectors.reload.done" : "connectors.reload.nextSession"),
        );
      } catch (e) {
        if (e instanceof ConnectorsApiError && e.code !== "http_error") throw e;
        throw new ConnectorsApiError(0, "reload_failed", e instanceof Error ? e.message : "");
      }
    });

  const onAdded = async (name: string) => {
    markDirty();
    setSelected(name);
    const v = await load();
    const next = paneAfterAdd(v, name);
    setPane(next);
    // Test right away so the card goes "checking" -> "connected" without another click.
    if (next === "detail") await runTest(name);
  };

  const sections: Section[] = canManage ? ["overview", "tools", "auth"] : ["overview", "tools"];
  const shownTools =
    tools.status === "ready"
      ? tools.tools.filter((x) => {
          const q = toolQuery.trim().toLowerCase();
          return !q || x.name.toLowerCase().includes(q) || x.description.toLowerCase().includes(q);
        })
      : [];

  const testButton = row && canManage && (
    <button
      type="button"
      data-action="test"
      disabled={busyTest.has(row.name)}
      onClick={() => void runTest(row.name)}
      className="rounded border border-border px-2 py-1 text-xs text-text hover:bg-surface-raised disabled:opacity-50"
    >
      {busyTest.has(row.name) ? t("connectors.state.checking") : t("connectors.manager.test")}
    </button>
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="connector-manager-title"
        className="flex h-[88dvh] w-[96vw] max-w-[1100px] flex-col rounded-xl border border-border bg-bg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex flex-shrink-0 items-center gap-3 border-b border-border px-5 py-3">
          <h2 id="connector-manager-title" className="flex items-center gap-1.5 text-sm font-bold">
            <Plug className="h-4 w-4" />
            {t("connectors.manager.title", { name: npcName })}
          </h2>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close")}
            className="text-text-muted hover:text-text"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        {dirty && canManage && (
          <div
            data-testid="connectors-reload-banner"
            className="flex items-center gap-3 border-b border-border bg-surface-raised px-5 py-2 text-xs"
          >
            <span className="flex-1 text-text">{t("connectors.reload.banner")}</span>
            <button
              type="button"
              disabled={busy}
              onClick={() => void apply()}
              className="rounded bg-primary px-3 py-1 text-white disabled:opacity-50"
            >
              {t("connectors.reload.apply")}
            </button>
          </div>
        )}
        {reloadNote && <p className="px-5 py-1 text-xs text-success">{reloadNote}</p>}
        {actionError && (
          <div className="flex items-center gap-3 px-5 py-1 text-xs">
            <span className="text-danger">{actionError}</span>
            {conflict && (
              <button
                type="button"
                data-action="reload-tools"
                onClick={reloadTools}
                className="text-primary"
              >
                {t("connectors.reload.reloadList")}
              </button>
            )}
          </div>
        )}

        {loadError !== null ? (
          <p className="p-5 text-sm text-danger">
            {t(
              loadError instanceof ConnectorsApiError && loadError.status === 409
                ? "connectors.gatewayDisconnected"
                : loadError instanceof ConnectorsApiError &&
                    loadError.code === "plugin_upgrade_required"
                  ? "connectors.error.plugin_upgrade_required"
                  : "connectors.error.load",
            )}
          </p>
        ) : !view ? (
          <p className="p-5 text-sm text-text-dim">{t("connectors.loading")}</p>
        ) : (
          <div className="flex min-h-0 flex-1">
            <aside className="w-64 flex-shrink-0 overflow-y-auto border-r border-border p-2 text-sm">
              {canManage && (
                <button
                  type="button"
                  data-action="add"
                  onClick={() => setPane("add")}
                  className="mb-2 flex items-center gap-1 px-1 text-xs text-primary"
                >
                  <Plus className="h-3 w-3" />
                  {t("connectors.manager.add")}
                </button>
              )}
              {view.servers.length === 0 && (
                <p className="p-2 text-text-dim">{t("connectors.empty")}</p>
              )}
              {view.servers.map((s) => {
                const state = cardState(s, busyTest.has(s.name));
                return (
                  <button
                    key={s.name}
                    type="button"
                    data-server={s.name}
                    aria-current={selected === s.name ? "true" : undefined}
                    onClick={() => {
                      setSelected(s.name);
                      setPane("detail");
                    }}
                    className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left ${
                      selected === s.name
                        ? "bg-surface-raised text-text"
                        : "text-text-muted hover:text-text"
                    }`}
                  >
                    <span className={`h-2 w-2 flex-shrink-0 rounded-full ${STATE_DOT[state]}`} />
                    <span className="min-w-0 flex-1 truncate">{s.name}</span>
                    <span className="text-[10px] text-text-dim">
                      {t(`connectors.state.${state}`)}
                    </span>
                  </button>
                );
              })}
            </aside>

            <main className="min-w-0 flex-1 overflow-y-auto p-5 text-sm">
              {pane === "add" && canManage ? (
                <ConnectorAddPane
                  api={api}
                  onAdded={(name) => void onAdded(name)}
                  onCancel={() => setPane("detail")}
                />
              ) : pane === "oauth" && canManage && selected ? (
                <ConnectorOAuthStep
                  api={api}
                  server={selected}
                  onDone={() => {
                    const name = selected;
                    setPane("detail");
                    markDirty();
                    // The test re-reads the list when it ends, so the card lands on its real state.
                    void runTest(name);
                  }}
                  onCancel={() => setPane("detail")}
                />
              ) : pane === "copy" && canManage && selected ? (
                <ConnectorCopyPane
                  api={api}
                  server={selected}
                  targets={copyTargets}
                  onDone={() => setPane("detail")}
                />
              ) : !row ? (
                <p className="text-text-dim">{t("connectors.manager.pick")}</p>
              ) : (
                <>
                  <nav className="mb-4 flex gap-3 text-xs" role="tablist">
                    {sections.map((k) => (
                      <button
                        key={k}
                        type="button"
                        role="tab"
                        data-section={k}
                        aria-selected={section === k}
                        onClick={() => setSection(k)}
                        className={
                          section === k ? "text-primary" : "text-text-muted hover:text-text"
                        }
                      >
                        {t(`connectors.section.${k}`)}
                      </button>
                    ))}
                  </nav>

                  {section === "overview" && (
                    <div className="flex max-w-xl flex-col gap-3">
                      <div>
                        <p className="text-[11px] text-text-muted">
                          {t(
                            row.transport === "stdio"
                              ? "connectors.overview.command"
                              : "connectors.overview.endpoint",
                          )}
                        </p>
                        {row.transport === "stdio" && detail?.command ? (
                          <code
                            data-testid="connector-command"
                            className="block break-all rounded bg-surface-raised px-2 py-1 text-xs"
                          >
                            {[detail.command, ...detail.args].join(" ")}
                          </code>
                        ) : (
                          <p className="break-all text-text">
                            {detail?.url ?? row.endpointSummary}
                          </p>
                        )}
                      </div>
                      {row.lastCheck && !row.lastCheck.ok && row.lastCheck.error && (
                        <p className="text-xs text-danger">
                          {t("connectors.overview.lastError", { detail: row.lastCheck.error })}
                        </p>
                      )}
                      {canManage && (
                        <>
                          <label className="flex items-center gap-2">
                            <Switch
                              action="enabled"
                              on={row.enabled}
                              label={t("connectors.overview.enabled")}
                              disabled={busy}
                              onToggle={() =>
                                void run(async () => {
                                  await api.setEnabled(row.name, !row.enabled);
                                  markDirty();
                                  await load();
                                })
                              }
                            />
                            <span>{t("connectors.overview.enabled")}</span>
                          </label>
                          <div>
                            <p className="text-[11px] text-text-muted">
                              {t("connectors.trust.label")}
                            </p>
                            <label className="mt-1 flex items-center gap-2">
                              <Switch
                                action="trust"
                                on={row.trust === "untrusted"}
                                label={t("connectors.trust.untrusted")}
                                disabled={busy}
                                onToggle={() =>
                                  void run(async () => {
                                    await api.setTrust(
                                      row.name,
                                      row.trust === "untrusted" ? "full" : "untrusted",
                                    );
                                    markDirty();
                                    await load();
                                  })
                                }
                              />
                              <span>
                                {t(
                                  row.trust === "untrusted"
                                    ? "connectors.trust.untrusted"
                                    : "connectors.trust.full",
                                )}
                              </span>
                            </label>
                            <p className="mt-1 text-[11px] text-text-dim">
                              {t("connectors.trust.untrustedHelp")}
                            </p>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            {testButton}
                            <button
                              type="button"
                              data-action="copy"
                              disabled={copyTargets.length === 0}
                              onClick={() => setPane("copy")}
                              className="rounded border border-border px-2 py-1 text-xs text-text hover:bg-surface-raised disabled:opacity-50"
                            >
                              {t("connectors.manager.copy")}
                            </button>
                            <button
                              type="button"
                              data-action="delete"
                              onClick={() => setDeleteText("")}
                              className="rounded border border-border px-2 py-1 text-xs text-danger hover:bg-surface-raised"
                            >
                              {t("connectors.manager.delete")}
                            </button>
                          </div>
                          {deleteText !== null && (
                            <div className="rounded border border-border p-2 text-xs">
                              <p>{t("connectors.manager.deleteConfirm", { name: row.name })}</p>
                              <input
                                data-testid="delete-confirm-input"
                                value={deleteText}
                                onChange={(e) => setDeleteText(e.target.value)}
                                aria-label={t("connectors.manager.deleteConfirm", {
                                  name: row.name,
                                })}
                                className="mt-1 w-full rounded bg-surface-raised px-2 py-1 text-text"
                              />
                              <div className="mt-2 flex gap-3">
                                <button
                                  type="button"
                                  data-action="confirm-delete"
                                  disabled={busy || deleteText !== row.name}
                                  onClick={() =>
                                    void run(async () => {
                                      await api.remove(row.name);
                                      markDirty();
                                      setSelected(null);
                                      const v = await load();
                                      setSelected(v?.servers[0]?.name ?? null);
                                    })
                                  }
                                  className="text-danger disabled:opacity-50"
                                >
                                  {t("connectors.manager.delete")}
                                </button>
                                <button
                                  type="button"
                                  className="text-text-muted"
                                  onClick={() => setDeleteText(null)}
                                >
                                  {t("common.cancel")}
                                </button>
                              </div>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )}

                  {section === "tools" && (
                    <div className="flex flex-col gap-2">
                      {tools.status === "unknown" && (
                        <div data-testid="connector-tools-unknown" className="flex flex-col gap-2">
                          <p className="text-text-muted">{t("connectors.tools.unknown")}</p>
                          <div>{testButton}</div>
                        </div>
                      )}
                      {tools.status === "error" && (
                        <p className="text-xs text-danger">{tools.message}</p>
                      )}
                      {tools.status === "ready" && (
                        <>
                          <div className="flex flex-wrap items-center gap-2">
                            <input
                              value={toolQuery}
                              onChange={(e) => setToolQuery(e.target.value)}
                              placeholder={t("connectors.tools.search")}
                              aria-label={t("connectors.tools.search")}
                              className="min-w-0 flex-1 rounded bg-surface-raised px-2 py-1 text-text"
                            />
                            {canManage &&
                              (
                                [
                                  ["all", "connectors.tools.all"],
                                  ["noDestructive", "connectors.tools.noDestructive"],
                                  ["readOnly", "connectors.tools.readOnlyOnly"],
                                ] as [QuickAction, string][]
                              ).map(([action, key]) => (
                                <button
                                  key={action}
                                  type="button"
                                  data-quick={action}
                                  disabled={busy}
                                  onClick={() =>
                                    void saveTools(quickAction(tools.tools, action).include)
                                  }
                                  className="text-xs text-primary disabled:opacity-50"
                                >
                                  {t(key)}
                                </button>
                              ))}
                          </div>
                          {shownTools.map((tool) => (
                            <div
                              key={tool.name}
                              data-tool={tool.name}
                              className="flex items-start gap-2 rounded px-1 py-1 hover:bg-surface-raised"
                            >
                              {canManage ? (
                                <Switch
                                  action="tool"
                                  on={tool.on}
                                  label={tool.name}
                                  disabled={busy}
                                  onToggle={() =>
                                    void saveTools(
                                      tools.tools
                                        .filter((x) => (x.name === tool.name ? !x.on : x.on))
                                        .map((x) => x.name),
                                    )
                                  }
                                />
                              ) : (
                                <span className="w-7 flex-shrink-0 text-[10px] text-text-muted">
                                  {t(tool.on ? "skills.on" : "skills.off")}
                                </span>
                              )}
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                  <span className="truncate text-text">{tool.name}</span>
                                  {tool.readOnlyHint === true && (
                                    <span className="text-[10px] text-success">
                                      {t("connectors.tools.readOnly")}
                                    </span>
                                  )}
                                  {tool.destructiveHint === true && (
                                    <span className="text-[10px] text-danger">
                                      {t("connectors.tools.destructive")}
                                    </span>
                                  )}
                                </div>
                                <p className="text-[11px] text-text-dim">{tool.description}</p>
                              </div>
                            </div>
                          ))}
                        </>
                      )}
                    </div>
                  )}

                  {section === "auth" && canManage && (
                    <div className="flex max-w-xl flex-col gap-3">
                      {row.auth === "oauth" && (
                        <div className="flex items-center gap-3">
                          <span>
                            {t(
                              row.oauthTokenPresent
                                ? "connectors.oauth.status.connected"
                                : "connectors.oauth.status.missing",
                            )}
                          </span>
                          <button
                            type="button"
                            data-action="oauth"
                            onClick={() => setPane("oauth")}
                            className="text-xs text-primary"
                          >
                            {t("connectors.oauth.start")}
                          </button>
                        </div>
                      )}
                      {row.auth !== "oauth" && row.secrets.length === 0 && (
                        <p className="text-text-muted">{t("connectors.secret.none")}</p>
                      )}
                      {row.secrets.map((secret) => (
                        <div key={secret.key} className="flex flex-col gap-1">
                          <span className="text-[11px] text-text-muted">{secret.key}</span>
                          <div className="flex items-center gap-2">
                            <input
                              type="password"
                              data-secret={secret.key}
                              autoComplete="off"
                              data-1p-ignore=""
                              data-lpignore="true"
                              aria-label={secret.key}
                              value={secretInputs[secret.key] ?? ""}
                              onChange={(e) =>
                                setSecretInputs((prev) => ({
                                  ...prev,
                                  [secret.key]: e.target.value,
                                }))
                              }
                              placeholder={t(
                                secret.hasValue
                                  ? "connectors.secret.saved"
                                  : "connectors.secret.empty",
                              )}
                              className="min-w-0 flex-1 rounded bg-surface-raised px-2 py-1 text-text"
                            />
                            <button
                              type="button"
                              data-action="save-secret"
                              data-key={secret.key}
                              disabled={busy || !(secretInputs[secret.key] ?? "")}
                              onClick={() =>
                                void run(async () => {
                                  await api.putSecret(
                                    row.name,
                                    secret.key,
                                    secretInputs[secret.key] ?? "",
                                  );
                                  setSecretInputs((prev) => ({ ...prev, [secret.key]: "" }));
                                  markDirty();
                                  await load();
                                })
                              }
                              className="text-xs text-primary disabled:opacity-50"
                            >
                              {t("connectors.secret.save")}
                            </button>
                            {secret.hasValue && (
                              <button
                                type="button"
                                data-action="clear-secret"
                                data-key={secret.key}
                                disabled={busy}
                                onClick={() =>
                                  void run(async () => {
                                    await api.deleteSecret(row.name, secret.key);
                                    markDirty();
                                    await load();
                                  })
                                }
                                className="text-xs text-danger disabled:opacity-50"
                              >
                                {t("connectors.secret.clear")}
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </main>
          </div>
        )}
      </div>
    </div>
  );
}
