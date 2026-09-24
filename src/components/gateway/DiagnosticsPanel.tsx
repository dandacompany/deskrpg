"use client";

import { useEffect, useState } from "react";

import { useT } from "@/lib/i18n";

/**
 * The diagnostics area on `/gateways`. Since 2026-09-20 it opens via the top "Diagnostics"
 * button instead of sitting at the bottom of the screen — leaving it always expanded just
 * makes the screen longer. This component stays mounted (it resolves permission only once),
 * and `open` decides visibility. Without permission it reports `onAvailable(false)` so even
 * the button never appears. It shows the same thing `deskrpg doctor` shows on the CLI.
 *
 * For a non-admin user the server returns 404, and at that point this component **renders
 * nothing at all** — it doesn't even leave a trace on screen that the admin feature exists.
 * It only shows the sentences the server produced; the browser never pokes the gateway/DB
 * directly (secrets never leave the server).
 */
type DiagnosticsReport = {
  environment: { errors: string[]; warnings: string[]; dbTarget: string };
  database: { ok: boolean; target: string; message: string };
  hostSetup: { wizard: boolean; hermesInstall: boolean };
  gateways: { id: string; label: string; pluginStatus: string; checkedAt: string | null }[];
};

type State =
  | { kind: "loading" }
  | { kind: "hidden" }
  | { kind: "failed" }
  | { kind: "ready"; report: DiagnosticsReport };

const mark = (value: boolean) => (value ? "✓" : "✗");

export default function DiagnosticsPanel({
  open = true,
  onAvailable,
}: {
  open?: boolean;
  onAvailable?: (available: boolean) => void;
} = {}) {
  const t = useT();
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/admin/diagnostics");
        if (cancelled) return;
        // 404 is "no permission" in disguise — disappear quietly.
        if (res.status === 404) return setState({ kind: "hidden" });
        if (!res.ok) return setState({ kind: "failed" });
        setState({ kind: "ready", report: (await res.json()) as DiagnosticsReport });
      } catch {
        if (!cancelled) setState({ kind: "failed" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Notify the caller once the decision is made — from an effect, so we don't mutate parent state during render.
  const available = state.kind === "ready" || state.kind === "failed";
  useEffect(() => {
    if (state.kind !== "loading") onAvailable?.(available);
  }, [state.kind, available, onAvailable]);

  if (!available || !open) return null;

  return (
    <details
      data-testid="diagnostics-panel"
      className="rounded-xl border border-border bg-surface p-5"
    >
      <summary className="cursor-pointer text-lg font-semibold">{t("diagnostics.title")}</summary>
      {state.kind === "failed" ? (
        <p className="mt-3 text-sm text-danger">{t("diagnostics.failed")}</p>
      ) : (
        <div className="mt-4 space-y-4 text-sm">
          <section>
            <h3 className="font-semibold">
              {t("diagnostics.environment")} · {state.report.environment.dbTarget}
            </h3>
            {state.report.environment.errors.length === 0 &&
            state.report.environment.warnings.length === 0 ? (
              <p className="mt-1 text-text-muted">{t("diagnostics.none")}</p>
            ) : (
              <ul className="mt-1 space-y-1">
                {state.report.environment.errors.map((message) => (
                  <li key={message} className="text-danger">
                    ✗ {message}
                  </li>
                ))}
                {state.report.environment.warnings.map((message) => (
                  <li key={message} className="text-text-muted">
                    ! {message}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h3 className="font-semibold">
              {t("diagnostics.database")} · {state.report.database.target}
            </h3>
            <p className={`mt-1 ${state.report.database.ok ? "text-text-muted" : "text-danger"}`}>
              {mark(state.report.database.ok)} {state.report.database.message}
            </p>
          </section>

          <section>
            <h3 className="font-semibold">{t("diagnostics.hostSetup")}</h3>
            {/* Do not translate the env var names — operators must find and flip these switches as-is. */}
            <ul className="mt-1 space-y-1 text-text-muted">
              <li>{mark(state.report.hostSetup.wizard)} DESKRPG_HOST_SETUP_ENABLED</li>
              <li>{mark(state.report.hostSetup.hermesInstall)} DESKRPG_HERMES_INSTALL_ENABLED</li>
            </ul>
          </section>

          <section>
            <h3 className="font-semibold">{t("diagnostics.gateways")}</h3>
            {state.report.gateways.length === 0 ? (
              <p className="mt-1 text-text-muted">{t("diagnostics.none")}</p>
            ) : (
              <ul className="mt-1 space-y-1 text-text-muted">
                {state.report.gateways.map((gateway) => (
                  <li key={gateway.id}>
                    {gateway.label} · {gateway.pluginStatus}
                    {gateway.checkedAt ? ` · ${gateway.checkedAt}` : ""}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </details>
  );
}
