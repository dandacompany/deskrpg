"use client";

/**
 * Picks a single tool's provider and enters the required API key — the per-tool config step of `hermes tools`.
 *
 * Rows come straight from Hermes's `TOOL_CATEGORIES` via the plugin (0.10.0). Keys are
 * write-only — the server only reports whether it's configured, and an entered value is
 * cleared from the screen after saving too. A row that needs server-side install or a
 * subscription login (`setup: "cli"`) can't be selected — it only guides the command.
 *
 * Only the owner sees this panel (the write route is owner-only). The caller makes that call.
 */
import { useCallback, useEffect, useState, type JSX } from "react";

import { useT } from "@/lib/i18n";
import { getLocalizedErrorMessage } from "@/lib/i18n/error-codes";
import type { ToolProviderRow, ToolProvidersPayload } from "@/lib/hermes/plugin-client-types";

import { isSafeHttpUrl } from "./provider-auth-model";
import { SECRET_INPUT_PROPS } from "./secret-input";

type Props = {
  profileBase: string;
  toolset: string;
  /** Saving is done — the caller updates displays like "key needed." */
  onSaved?(result: { provider: string; ready: boolean }): void;
  disabled?: boolean;
};

type Body = Record<string, unknown>;

async function readBody(res: Response): Promise<Body> {
  try {
    const body: unknown = await res.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return { errorCode: "malformed_response" };
    }
    return body as Body;
  } catch {
    return { errorCode: "malformed_response" };
  }
}

/**
 * The row picked initially: what's currently in use -> an already-ready row (e.g. a free
 * one that needs no key) -> the first row the app can select. Hermes's row order is by
 * recommendation, but the first row is often a subscription/install row or needs a key
 * (observed with web search).
 */
export function defaultProviderChoice(payload: ToolProvidersPayload): string | null {
  if (payload.activeProvider) return payload.activeProvider;
  const selectable = payload.providers.filter((p) => p.setup !== "cli");
  return (selectable.find((p) => p.status === "ready") ?? selectable[0])?.name ?? null;
}

/** A non-secret value like a URL — not masked, but the password-manager markers are kept. */
export function isPlainEnvValue(key: string): boolean {
  return /_(URL|BASE_URL|HOST|ENDPOINT)$/.test(key);
}

const STATUS_KEY: Record<ToolProviderRow["status"], string> = {
  ready: "hermes.toolProviders.status.ready",
  needs_keys: "hermes.toolProviders.status.needsKeys",
  needs_setup: "hermes.toolProviders.status.needsSetup",
  needs_auth: "hermes.toolProviders.status.needsAuth",
};

export default function ToolProviderPanel({
  profileBase,
  toolset,
  onSaved,
  disabled,
}: Props): JSX.Element {
  const t = useT();
  const base = `${profileBase}/toolsets/${encodeURIComponent(toolset)}`;
  const [payload, setPayload] = useState<ToolProvidersPayload | null>(null);
  const [loadError, setLoadError] = useState<Body | null>(null);
  const [choice, setChoice] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<Body | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(
    async (keepChoice: boolean) => {
      setLoadError(null);
      try {
        const res = await fetch(`${base}/providers`);
        const body = await readBody(res);
        if (typeof body.errorCode === "string" || !res.ok) {
          setLoadError(body);
          return;
        }
        const next = body as unknown as ToolProvidersPayload;
        setPayload(next);
        setChoice((prev) => (keepChoice && prev ? prev : defaultProviderChoice(next)));
      } catch {
        setLoadError({});
      }
    },
    [base],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  const row = payload?.providers.find((p) => p.name === choice) ?? null;
  const missing = row
    ? row.envVars.filter((e) => !e.isSet && !(values[e.key] ?? "").trim()).map((e) => e.key)
    : [];

  const save = async () => {
    if (!row || row.setup === "cli" || missing.length > 0) return;
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const env: Record<string, string> = {};
      for (const e of row.envVars) {
        const v = (values[e.key] ?? "").trim();
        if (v) env[e.key] = v;
      }
      const res = await fetch(`${base}/provider`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: row.name, env }),
      });
      const body = await readBody(res);
      if (typeof body.errorCode === "string" || !res.ok) {
        setSaveError(body);
        return;
      }
      // The key value is cleared from the screen after saving too — there's no reason to show it again.
      setValues({});
      setSaved(true);
      onSaved?.({ provider: row.name, ready: true });
      await load(true);
    } catch {
      setSaveError({});
    } finally {
      setSaving(false);
    }
  };

  if (loadError) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs text-danger">
          {getLocalizedErrorMessage(t, loadError, "hermes.toolProviders.loadFailed")}
        </p>
        <button
          type="button"
          onClick={() => void load(false)}
          className="rounded bg-surface-raised px-2 py-1 text-xs font-semibold"
        >
          {t("hermes.picker.retry")}
        </button>
      </div>
    );
  }
  if (!payload) return <p className="text-xs text-text-muted">{t("hermes.picker.loading")}</p>;

  return (
    <div className="space-y-3" data-tool-panel={toolset}>
      <p className="text-xs font-semibold text-text">{t("hermes.toolProviders.choose")}</p>
      <div className="space-y-1">
        {payload.providers.map((p) => (
          <label key={p.name} className="flex items-start gap-2 text-sm text-text">
            <input
              type="radio"
              name={`tool-provider-${toolset}`}
              className="mt-1"
              value={p.name}
              checked={choice === p.name}
              disabled={disabled || saving}
              onChange={() => {
                setChoice(p.name);
                setSaved(false);
                setSaveError(null);
              }}
            />
            <span className="min-w-0">
              <span className="font-medium">{p.name}</span>
              {p.badge && (
                <span className="ml-2 rounded bg-surface-raised px-1.5 py-0.5 text-[10px] text-text-muted">
                  {p.badge}
                </span>
              )}
              {p.active && (
                <span className="ml-1 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                  {t("hermes.toolProviders.inUse")}
                </span>
              )}
              <span className="ml-1 text-[10px] text-text-muted">{t(STATUS_KEY[p.status])}</span>
              {p.tag && <span className="block text-xs text-text-muted">{p.tag}</span>}
            </span>
          </label>
        ))}
      </div>

      {row?.setup === "cli" && (
        <div className="space-y-1 text-xs text-text-muted">
          <p>{t("hermes.toolProviders.cliHint")}</p>
          <code className="block rounded bg-bg px-2 py-1 text-text">{payload.cliCommand}</code>
        </div>
      )}

      {row?.setup === "keys" && (
        <div className="space-y-2">
          {row.envVars.map((e) => (
            <label key={e.key} className="block space-y-1 text-xs text-text">
              <span className="font-semibold">
                {e.prompt}
                <span className="ml-2 font-mono font-normal text-text-muted">{e.key}</span>
                {e.url && isSafeHttpUrl(e.url) && (
                  <a
                    href={e.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ml-2 font-normal text-primary underline"
                  >
                    {t("hermes.toolProviders.getKey")}
                  </a>
                )}
              </span>
              <input
                {...SECRET_INPUT_PROPS}
                type={isPlainEnvValue(e.key) ? "text" : "password"}
                data-env-key={e.key}
                value={values[e.key] ?? ""}
                disabled={disabled || saving}
                placeholder={
                  e.isSet
                    ? t("hermes.toolProviders.keySetPlaceholder")
                    : isPlainEnvValue(e.key)
                      ? t("hermes.toolProviders.urlPlaceholder")
                      : t("hermes.providerAuth.keyPlaceholder")
                }
                onChange={(ev) => setValues((prev) => ({ ...prev, [e.key]: ev.target.value }))}
                className="w-full rounded border border-border bg-bg px-3 py-2 text-sm text-text focus:outline-none focus:border-primary-light"
              />
            </label>
          ))}
        </div>
      )}

      {saveError && (
        <p className="text-xs text-danger">
          {getLocalizedErrorMessage(t, saveError, "hermes.toolProviders.saveFailed")}
        </p>
      )}
      {saved && <p className="text-xs text-success">{t("hermes.toolProviders.saved")}</p>}

      {row && row.setup !== "cli" && (
        <button
          type="button"
          onClick={() => void save()}
          disabled={disabled || saving || missing.length > 0}
          className="rounded bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:bg-primary-hover disabled:opacity-60"
        >
          {saving ? t("hermes.wizard.config.saving") : t("hermes.toolProviders.save")}
        </button>
      )}
    </div>
  );
}
