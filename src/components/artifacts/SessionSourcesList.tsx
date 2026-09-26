"use client";
import { useState } from "react";

import type { SessionSource } from "@/lib/hermes/deskrpg-plugin-types";
import { useT } from "@/lib/i18n";
import type { SessionSourcesView } from "@/lib/session-sources-types";

function safeHref(ref: string): string | null {
  try {
    const url = new URL(ref);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function SourceItem({ source }: { source: SessionSource }) {
  const href = source.kind === "web" ? safeHref(source.ref) : null;
  const label = source.title || source.ref;
  return (
    <li data-source-kind={source.kind} className="break-all">
      {href ? (
        <a href={href} target="_blank" rel="noopener noreferrer" className="underline text-primary">
          {label}
        </a>
      ) : (
        <span className="font-mono text-text-secondary">{source.ref}</span>
      )}
      {href && source.title && <span className="ml-1 text-text-dim">{new URL(href).host}</span>}
    </li>
  );
}

/**
 * "What this work read" — the pages and files the Hermes session behind it actually opened. Loaded
 * only when opened, since every look is a read of the session on the gateway.
 */
export default function SessionSourcesList({ load }: { load: () => Promise<SessionSourcesView> }) {
  const t = useT();
  const [view, setView] = useState<SessionSourcesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);

  const open = () => {
    if (started) return;
    setStarted(true);
    load().then(setView, (err: unknown) =>
      setError(err instanceof Error ? err.message : String(err)),
    );
  };

  const body = (() => {
    if (error)
      return <p className="text-danger break-words">{`${t("artifacts.error")} — ${error}`}</p>;
    if (!view) return <p className="text-text-dim">{t("common.loading")}</p>;
    switch (view.status) {
      case "expired":
        return <p data-sources-state="expired">{t("sources.expired")}</p>;
      case "none":
        return <p data-sources-state="none">{t("sources.none")}</p>;
      case "unavailable":
        return (
          <p data-sources-state={view.reason}>
            {view.reason === "plugin_upgrade_required"
              ? t("sources.pluginUpgrade", { version: view.minVersion ?? "" })
              : t("sources.noProfileKey")}
          </p>
        );
      case "ok":
        return (
          <div data-sources-state="ok" className="space-y-1">
            {view.sources.length === 0 ? (
              <p>{t("sources.empty")}</p>
            ) : (
              <ul className="space-y-0.5">
                {view.sources.map((s) => (
                  <SourceItem key={`${s.kind}:${s.ref}`} source={s} />
                ))}
              </ul>
            )}
            {view.outsideWorkdirFiles > 0 && (
              <p data-sources-outside="" className="text-text-dim">
                {t("sources.outside", { count: view.outsideWorkdirFiles })}
              </p>
            )}
            {view.truncated && <p className="text-text-dim">{t("sources.truncated")}</p>}
          </div>
        );
    }
  })();

  return (
    <details
      data-session-sources=""
      onToggle={(e) => {
        if ((e.currentTarget as HTMLDetailsElement).open) open();
      }}
      className="text-xs text-text-secondary"
    >
      <summary className="cursor-pointer text-text-dim">{t("sources.title")}</summary>
      <div className="mt-1">{body}</div>
    </details>
  );
}
