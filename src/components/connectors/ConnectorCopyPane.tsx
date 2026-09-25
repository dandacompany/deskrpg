"use client";
import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, XCircle } from "lucide-react";

import type { McpServerDetail } from "@/lib/hermes/plugin-client-types";
import { useT } from "@/lib/i18n";

import { connectorErrorText } from "./connector-error-text";
import type { CopyResult } from "./connector-types";
import { ConnectorsApiError, type ConnectorsApi } from "./connectors-api";

export type ConnectorCopyPaneProps = {
  api: ConnectorsApi;
  server: string;
  /** Other active NPCs of this channel (display names from `hermes_profiles`). */
  targets: { npcId: string; name: string }[];
  onDone(): void;
};

/**
 * Copies a server's settings (never secrets or OAuth) to other NPCs. The copy carries a stdio
 * server's run confirmation along, so for a stdio server the exact command is shown here and has
 * to be acknowledged — it will run on each recipient's Hermes host too. Each target succeeds or
 * fails on its own (e.g. `name_taken`); the result list shows both.
 */
export default function ConnectorCopyPane({
  api,
  server,
  targets,
  onDone,
}: ConnectorCopyPaneProps) {
  const t = useT();
  const [detail, setDetail] = useState<McpServerDetail | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [stdioOk, setStdioOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<CopyResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stale = false;
    setDetail(null);
    setStdioOk(false);
    api
      .detail(server)
      .then((d) => {
        if (!stale) setDetail(d);
      })
      .catch((e) => {
        if (!stale) setError(connectorErrorText(t, e));
      });
    return () => {
      stale = true;
    };
  }, [api, server, t]);

  const stdio = detail?.transport === "stdio";
  const command = stdio ? [detail.command ?? "", ...detail.args].join(" ").trim() : "";
  const canCopy = !!detail && picked.length > 0 && (!stdio || stdioOk) && !busy;
  const nameOf = (npcId: string) => targets.find((x) => x.npcId === npcId)?.name ?? npcId;
  const resultText = (r: CopyResult) =>
    r.ok
      ? t("connectors.copy.resultOk")
      : connectorErrorText(t, new ConnectorsApiError(0, r.code ?? "", ""));

  const copy = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.copy(picked, [server]);
      setResults(res.results);
    } catch (e) {
      setError(connectorErrorText(t, e));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (npcId: string) =>
    setPicked((p) => (p.includes(npcId) ? p.filter((x) => x !== npcId) : [...p, npcId]));

  return (
    <div className="flex max-w-xl flex-col gap-3 text-sm">
      <h4 className="font-semibold text-text">{t("connectors.copy.title")}</h4>
      <p className="text-xs text-text-muted">{t("connectors.copy.intro", { server })}</p>
      <div className="rounded bg-surface-raised p-2 text-xs text-text-muted">
        <p>{t("connectors.copy.notice")}</p>
        <p>{t("connectors.copy.carried")}</p>
      </div>
      {targets.length === 0 ? (
        <p className="text-xs text-text-dim">{t("connectors.copy.noTargets")}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {targets.map((x) => (
            <li key={x.npcId}>
              <label className="flex items-center gap-2 text-text">
                <input
                  type="checkbox"
                  data-target={x.npcId}
                  checked={picked.includes(x.npcId)}
                  disabled={busy}
                  onChange={() => toggle(x.npcId)}
                />
                {x.name}
              </label>
            </li>
          ))}
        </ul>
      )}
      {!detail && !error && (
        <p className="flex items-center gap-1.5 text-xs text-text-muted">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        </p>
      )}
      {stdio && (
        <div
          data-stdio-warning
          className="flex flex-col gap-1 rounded border border-danger/40 p-2 text-xs"
        >
          <p className="flex items-start gap-1.5 text-text">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" />
            {t("connectors.copy.stdioWarning", { command })}
          </p>
          <label className="flex items-center gap-2 text-text">
            <input
              type="checkbox"
              data-action="stdio-confirm"
              checked={stdioOk}
              onChange={(e) => setStdioOk(e.target.checked)}
            />
            {t("connectors.copy.stdioConfirm")}
          </label>
        </div>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          data-action="copy"
          disabled={!canCopy}
          onClick={() => void copy()}
          className="rounded bg-primary px-3 py-1 text-white disabled:opacity-50"
        >
          {busy ? t("connectors.copy.copying") : t("connectors.copy.submit")}
        </button>
        <button
          type="button"
          data-action="copy-done"
          onClick={onDone}
          className="rounded px-3 py-1 text-text-muted hover:bg-surface-raised"
        >
          {t("connectors.copy.done")}
        </button>
      </div>
      {results && (
        <ul className="flex flex-col gap-1 text-xs">
          {results.map((r) => (
            <li
              key={`${r.npcId}:${r.name}`}
              data-result={r.npcId}
              data-ok={r.ok ? "true" : "false"}
              className="flex items-center gap-1.5"
            >
              {r.ok ? (
                <CheckCircle2 className="h-3.5 w-3.5 text-primary" />
              ) : (
                <XCircle className="h-3.5 w-3.5 text-danger" />
              )}
              <span className="text-text">{nameOf(r.npcId)}</span>
              <span className={r.ok ? "text-text-muted" : "text-danger"}>{resultText(r)}</span>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p data-error className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
