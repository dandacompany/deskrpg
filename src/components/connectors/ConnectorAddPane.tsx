"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Loader2, Plus, X } from "lucide-react";

import { SECRET_INPUT_PROPS } from "@/components/hermes/secret-input";
import type {
  McpCatalogEntry,
  McpServerInput,
  McpServerView,
  McpTransport,
} from "@/lib/hermes/plugin-client-types";
import { useT } from "@/lib/i18n";

import { parseMcpJson } from "./connector-json-import";
import { connectorErrorText } from "./connector-error-text";
import type { ConnectorsApi } from "./connectors-api";

export type ConnectorAddPaneProps = {
  api: ConnectorsApi;
  /** Called with the new server's name once it is saved (the manager then selects it, or opens OAuth). */
  onAdded(name: string): void;
  onCancel(): void;
};

type Pair = { key: string; value: string };
type HttpAuth = "none" | "bearer" | "oauth";

type Form = {
  name: string;
  transport: McpTransport;
  url: string;
  headers: Pair[];
  auth: HttpAuth;
  /** Bearer token — a secret; cleared as soon as it is stored. */
  token: string;
  command: string;
  args: string;
  /** Env rows; values are secrets and are cleared as soon as they are stored. */
  env: Pair[];
  passthroughEnv: string;
  cwd: string;
};

const EMPTY: Form = {
  name: "",
  transport: "http",
  url: "",
  headers: [],
  auth: "none",
  token: "",
  command: "",
  args: "",
  env: [],
  passthroughEnv: "",
  cwd: "",
};

const lines = (s: string) =>
  s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

/** Shows the command as it will run — arguments with spaces are quoted so the boundary stays visible. */
function commandLine(form: Form): string {
  const quote = (a: string) => (/[\s"']/.test(a) ? JSON.stringify(a) : a);
  return [form.command.trim(), ...lines(form.args).map(quote)].join(" ");
}

function toInput(form: Form): McpServerInput {
  const name = form.name.trim();
  if (form.transport === "http") {
    const headers = Object.fromEntries(
      form.headers.filter((h) => h.key.trim()).map((h) => [h.key.trim(), h.value]),
    );
    return {
      name,
      transport: "http",
      url: form.url.trim(),
      ...(Object.keys(headers).length ? { headers } : {}),
      auth: form.auth,
    };
  }
  const envKeys = form.env.map((e) => e.key.trim()).filter(Boolean);
  const passthroughEnv = lines(form.passthroughEnv);
  const cwd = form.cwd.trim();
  return {
    name,
    transport: "stdio",
    command: form.command.trim(),
    args: lines(form.args),
    // Keys only — the plugin stores each as a `${KEY}` reference; values go through `putSecret`.
    ...(envKeys.length ? { env: Object.fromEntries(envKeys.map((k) => [k, ""])) } : {}),
    ...(passthroughEnv.length ? { passthroughEnv } : {}),
    ...(cwd ? { cwd } : {}),
    auth: envKeys.length ? "env" : "none",
  };
}

/**
 * Adds an MCP server to this NPC: [Catalog] installs a known entry with its required env, and
 * [Add manually] fills a form (optionally from pasted JSON). A stdio server is saved only after a
 * confirmation that shows the exact command and asks for the server name. Secrets are sent after
 * the server exists, under the key names the server reports, and are cleared from state right
 * away. OAuth servers skip the connection test — the manager opens the sign-in step instead.
 */
export default function ConnectorAddPane({ api, onAdded, onCancel }: ConnectorAddPaneProps) {
  const t = useT();
  const [tab, setTab] = useState<"catalog" | "custom">("catalog");
  const [entries, setEntries] = useState<McpCatalogEntry[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<McpCatalogEntry | null>(null);
  const [catalogEnv, setCatalogEnv] = useState<Record<string, string>>({});
  const [form, setForm] = useState<Form>(EMPTY);
  const [json, setJson] = useState("");
  const [jsonState, setJsonState] = useState<{ ok: boolean; name?: string } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    let stale = false;
    api
      .catalog()
      .then((r) => {
        if (!stale) setEntries(r.entries);
      })
      .catch((e) => {
        if (!stale) setCatalogError(connectorErrorText(t, e));
      });
    return () => {
      stale = true;
      alive.current = false;
    };
  }, [api, t]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!entries) return [];
    if (!q) return entries;
    return entries.filter(
      (e) => e.name.toLowerCase().includes(q) || e.description.toLowerCase().includes(q),
    );
  }, [entries, query]);

  const patch = (next: Partial<Form>) => setForm((f) => ({ ...f, ...next }));

  /** Saved: hand over — the manager runs the connection test (or opens sign-in) and tracks it. */
  const finish = (server: McpServerView) => {
    if (alive.current) onAdded(server.name);
  };

  const install = async () => {
    if (!picked) return;
    setBusy(true);
    setError(null);
    try {
      const server = await api.catalogInstall(picked.name, catalogEnv);
      setCatalogEnv({});
      finish(server);
    } catch (e) {
      if (alive.current) setError(connectorErrorText(t, e));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const save = async () => {
    const input = toInput(form);
    if (input.transport === "stdio") input.confirmName = confirmName.trim();
    setBusy(true);
    setError(null);
    let server: McpServerView;
    try {
      server = await api.create(input);
    } catch (e) {
      if (alive.current) {
        setError(connectorErrorText(t, e));
        setBusy(false);
      }
      return;
    }
    // Store secret values under the key names the server reports — never a guessed name.
    const values: Record<string, string> = {};
    if (form.transport === "http" && form.auth === "bearer" && form.token) {
      const key = server.secrets[0]?.key;
      if (key) values[key] = form.token;
    }
    if (form.transport === "stdio") {
      const reported = new Set(server.secrets.map((s) => s.key));
      for (const e of form.env) {
        if (e.value && reported.has(e.key.trim())) values[e.key.trim()] = e.value;
      }
    }
    setForm((f) => ({ ...f, token: "", env: f.env.map((e) => ({ ...e, value: "" })) }));
    try {
      for (const [key, value] of Object.entries(values)) {
        await api.putSecret(server.name, key, value);
      }
    } catch {
      /* the server exists; its detail view shows the missing secret and takes it again */
    }
    finish(server);
    if (alive.current) setBusy(false);
  };

  const applyJson = (raw: string) => {
    setJson(raw);
    if (!raw.trim()) {
      setJsonState(null);
      return;
    }
    const parsed = parseMcpJson(raw);
    if (!parsed.ok) {
      setJsonState({ ok: false });
      return;
    }
    const i = parsed.input;
    setForm({
      ...EMPTY,
      name: i.name ?? "",
      transport: i.transport ?? "http",
      url: i.url ?? "",
      auth: i.auth === "bearer" || i.auth === "oauth" ? i.auth : "none",
      command: i.command ?? "",
      args: (i.args ?? []).join("\n"),
      env: Object.keys(i.env ?? {}).map((key) => ({ key, value: "" })),
    });
    setJsonState({ ok: true, name: i.name });
  };

  const formReady =
    form.name.trim() !== "" &&
    (form.transport === "http" ? form.url.trim() !== "" : form.command.trim() !== "");
  const requiredMissing =
    picked?.requiredEnv.some((r) => r.required && !catalogEnv[r.name]?.trim()) ?? true;

  const inputCls = "min-w-0 rounded bg-surface-raised px-2 py-1 text-text";
  const segCls = (on: boolean) =>
    `rounded px-2 py-0.5 ${on ? "bg-primary text-white" : "text-text-muted hover:bg-surface-raised"}`;

  const pairRows = (
    rows: Pair[],
    set: (rows: Pair[]) => void,
    prefix: "header" | "env",
    secretValues: boolean,
  ) => (
    <div className="flex flex-col gap-1">
      {rows.map((row, i) => (
        <div key={i} className="flex gap-1">
          <input
            name={`${prefix}-key-${i}`}
            value={row.key}
            aria-label={
              prefix === "env" ? t("connectors.add.envKey") : t("connectors.add.headerKey")
            }
            placeholder={
              prefix === "env" ? t("connectors.add.envKey") : t("connectors.add.headerKey")
            }
            onChange={(e) => set(rows.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)))}
            className={`${inputCls} w-40 font-mono text-xs`}
          />
          <input
            name={`${prefix}-value-${i}`}
            value={row.value}
            aria-label={
              prefix === "env" ? t("connectors.add.envValue") : t("connectors.add.headerValue")
            }
            placeholder={
              prefix === "env" ? t("connectors.add.envValue") : t("connectors.add.headerValue")
            }
            onChange={(e) =>
              set(rows.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))
            }
            className={`${inputCls} flex-1 text-xs`}
            {...(secretValues ? SECRET_INPUT_PROPS : {})}
          />
          <button
            type="button"
            aria-label={t("connectors.add.remove")}
            onClick={() => set(rows.filter((_, j) => j !== i))}
            className="rounded px-1 text-text-muted hover:bg-surface-raised"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <button
        type="button"
        data-action={`add-${prefix}`}
        onClick={() => set([...rows, { key: "", value: "" }])}
        className="flex items-center gap-1 self-start text-xs text-primary"
      >
        <Plus className="h-3.5 w-3.5" />
        {prefix === "env" ? t("connectors.add.addEnv") : t("connectors.add.addHeader")}
      </button>
    </div>
  );

  const catalogPane = (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
      <div className="flex min-w-0 flex-col gap-2">
        <input
          name="catalog-query"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label={t("connectors.add.search")}
          placeholder={t("connectors.add.search")}
          className={inputCls}
        />
        {catalogError && <p className="text-xs text-danger">{catalogError}</p>}
        {!entries && !catalogError && (
          <p className="flex items-center gap-1.5 text-xs text-text-muted">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t("connectors.add.loading")}
          </p>
        )}
        {entries && shown.length === 0 && (
          <p className="text-xs text-text-dim">{t("connectors.add.catalogEmpty")}</p>
        )}
        <ul className="flex max-h-[50dvh] flex-col gap-1 overflow-y-auto">
          {shown.map((e) => (
            <li key={e.name}>
              <button
                type="button"
                data-entry={e.name}
                disabled={e.installed}
                aria-pressed={picked?.name === e.name}
                onClick={() => {
                  setPicked(e);
                  setCatalogEnv({});
                  setError(null);
                }}
                className={`w-full rounded px-2 py-1 text-left hover:bg-surface-raised disabled:opacity-60 ${
                  picked?.name === e.name ? "bg-surface-raised text-primary" : "text-text"
                }`}
              >
                <span className="flex items-center gap-1.5">
                  {e.name}
                  <span className="text-xs text-text-muted">· {e.transport}</span>
                  {e.installed && (
                    <span className="text-xs text-text-dim">{t("connectors.add.installed")}</span>
                  )}
                </span>
                {e.description && (
                  <span className="block truncate text-xs text-text-dim">{e.description}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </div>
      <section className="min-w-0 self-start rounded border border-border bg-surface p-3">
        {!picked && <p className="text-xs text-text-dim">{t("connectors.add.pickEntry")}</p>}
        {picked && (
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!requiredMissing && !busy) void install();
            }}
          >
            <h4 className="font-semibold text-text">{picked.name}</h4>
            {picked.description && <p className="text-xs text-text-muted">{picked.description}</p>}
            {picked.requiredEnv.map((r) => (
              <label key={r.name} className="flex flex-col gap-0.5 text-xs text-text-muted">
                <span>
                  {r.prompt || r.name} <span className="font-mono text-text-dim">{r.name}</span>
                  {r.required && (
                    <span className="text-text-dim"> · {t("connectors.add.required")}</span>
                  )}
                </span>
                <input
                  name={`env-${r.name}`}
                  value={catalogEnv[r.name] ?? ""}
                  onChange={(e) => setCatalogEnv((m) => ({ ...m, [r.name]: e.target.value }))}
                  className={inputCls}
                  {...(r.secret ? SECRET_INPUT_PROPS : { autoComplete: "off" })}
                />
              </label>
            ))}
            <button
              type="submit"
              data-action="catalog-install"
              disabled={requiredMissing || busy}
              className="self-start rounded bg-primary px-3 py-1 text-white disabled:opacity-50"
            >
              {busy ? t("connectors.add.installing") : t("connectors.add.install")}
            </button>
          </form>
        )}
      </section>
    </div>
  );

  const customPane = confirming ? (
    <section
      data-dialog="stdio-confirm"
      role="alertdialog"
      aria-labelledby="stdio-confirm-title"
      className="flex max-w-xl flex-col gap-2 rounded border border-danger/40 bg-surface p-3"
    >
      <h4 id="stdio-confirm-title" className="flex items-center gap-1.5 font-semibold text-text">
        <AlertTriangle className="h-4 w-4 text-danger" />
        {t("connectors.add.confirm.title")}
      </h4>
      <p className="text-xs text-text-muted">{t("connectors.add.confirm.body")}</p>
      <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded bg-surface-raised p-2 font-mono text-xs text-text">
        {commandLine(form)}
      </pre>
      {form.cwd.trim() && <p className="font-mono text-xs text-text-dim">cwd: {form.cwd.trim()}</p>}
      <label className="flex flex-col gap-0.5 text-xs text-text-muted">
        {t("connectors.add.confirm.nameLabel", { name: form.name.trim() })}
        <input
          name="confirm-name"
          value={confirmName}
          autoComplete="off"
          onChange={(e) => setConfirmName(e.target.value)}
          className={inputCls}
        />
      </label>
      <div className="flex gap-2">
        <button
          type="button"
          data-action="confirm-save"
          disabled={confirmName.trim() !== form.name.trim() || busy}
          onClick={() => void save()}
          className="rounded bg-danger px-3 py-1 text-white disabled:opacity-50"
        >
          {busy ? t("connectors.add.saving") : t("connectors.add.confirm.submit")}
        </button>
        <button
          type="button"
          data-action="confirm-back"
          disabled={busy}
          onClick={() => {
            setConfirming(false);
            setConfirmName("");
          }}
          className="rounded px-3 py-1 text-text-muted hover:bg-surface-raised"
        >
          {t("connectors.add.confirm.back")}
        </button>
      </div>
    </section>
  ) : (
    <form
      className="flex max-w-xl flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!formReady || busy) return;
        if (form.transport === "stdio") {
          setConfirmName("");
          setConfirming(true);
        } else void save();
      }}
    >
      <label className="flex flex-col gap-0.5 text-xs text-text-muted">
        {t("connectors.add.jsonLabel")}
        <textarea
          name="json-import"
          value={json}
          rows={3}
          spellCheck={false}
          onChange={(e) => applyJson(e.target.value)}
          className={`${inputCls} font-mono text-xs`}
        />
        <span className="text-text-dim">{t("connectors.add.jsonHint")}</span>
        {jsonState?.ok === false && (
          <span className="text-danger">{t("connectors.add.jsonInvalid")}</span>
        )}
        {jsonState?.ok && (
          <span className="text-text-muted">
            {t("connectors.add.jsonApplied", { name: jsonState.name ?? "" })}
          </span>
        )}
      </label>
      <label className="flex flex-col gap-0.5 text-xs text-text-muted">
        {t("connectors.add.name")}
        <input
          name="name"
          value={form.name}
          autoComplete="off"
          onChange={(e) => patch({ name: e.target.value })}
          className={`${inputCls} font-mono`}
        />
      </label>
      <div className="flex items-center gap-2 text-xs text-text-muted">
        {t("connectors.add.transport")}
        {(["http", "stdio"] as const).map((tr) => (
          <button
            key={tr}
            type="button"
            data-transport={tr}
            aria-pressed={form.transport === tr}
            onClick={() => patch({ transport: tr })}
            className={segCls(form.transport === tr)}
          >
            {t(`connectors.add.transport.${tr}`)}
          </button>
        ))}
      </div>
      {form.transport === "http" ? (
        <>
          <label className="flex flex-col gap-0.5 text-xs text-text-muted">
            {t("connectors.add.url")}
            <input
              name="url"
              value={form.url}
              autoComplete="off"
              placeholder="https://…"
              onChange={(e) => patch({ url: e.target.value })}
              className={inputCls}
            />
          </label>
          <div className="flex flex-col gap-0.5 text-xs text-text-muted">
            {t("connectors.add.headers")}
            {pairRows(form.headers, (headers) => patch({ headers }), "header", false)}
          </div>
          <div className="flex items-center gap-2 text-xs text-text-muted">
            {t("connectors.add.auth")}
            {(["none", "bearer", "oauth"] as const).map((a) => (
              <button
                key={a}
                type="button"
                data-auth={a}
                aria-pressed={form.auth === a}
                onClick={() => patch({ auth: a })}
                className={segCls(form.auth === a)}
              >
                {t(`connectors.add.auth.${a}`)}
              </button>
            ))}
          </div>
          {form.auth === "bearer" && (
            <label className="flex flex-col gap-0.5 text-xs text-text-muted">
              {t("connectors.add.token")}
              <input
                name="token"
                value={form.token}
                onChange={(e) => patch({ token: e.target.value })}
                className={inputCls}
                {...SECRET_INPUT_PROPS}
              />
            </label>
          )}
        </>
      ) : (
        <>
          <label className="flex flex-col gap-0.5 text-xs text-text-muted">
            {t("connectors.add.command")}
            <input
              name="command"
              value={form.command}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => patch({ command: e.target.value })}
              className={`${inputCls} font-mono`}
            />
          </label>
          <label className="flex flex-col gap-0.5 text-xs text-text-muted">
            {t("connectors.add.args")}
            <textarea
              name="args"
              value={form.args}
              rows={3}
              spellCheck={false}
              onChange={(e) => patch({ args: e.target.value })}
              className={`${inputCls} font-mono text-xs`}
            />
            <span className="text-text-dim">{t("connectors.add.argsHint")}</span>
          </label>
          <div className="flex flex-col gap-0.5 text-xs text-text-muted">
            {t("connectors.add.env")}
            {pairRows(form.env, (env) => patch({ env }), "env", true)}
          </div>
          <label className="flex flex-col gap-0.5 text-xs text-text-muted">
            {t("connectors.add.passthroughEnv")}
            <textarea
              name="passthrough-env"
              value={form.passthroughEnv}
              rows={2}
              spellCheck={false}
              onChange={(e) => patch({ passthroughEnv: e.target.value })}
              className={`${inputCls} font-mono text-xs`}
            />
            <span className="text-text-dim">{t("connectors.add.passthroughHint")}</span>
          </label>
          <label className="flex flex-col gap-0.5 text-xs text-text-muted">
            {t("connectors.add.cwd")}
            <input
              name="cwd"
              value={form.cwd}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => patch({ cwd: e.target.value })}
              className={`${inputCls} font-mono`}
            />
          </label>
        </>
      )}
      <button
        type="submit"
        data-action="save"
        disabled={!formReady || busy}
        className="self-start rounded bg-primary px-3 py-1 text-white disabled:opacity-50"
      >
        {busy ? t("connectors.add.saving") : t("connectors.add.save")}
      </button>
    </form>
  );

  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="flex items-center gap-2">
        {(["catalog", "custom"] as const).map((k) => (
          <button
            key={k}
            type="button"
            data-tab={k}
            aria-pressed={tab === k}
            onClick={() => {
              setTab(k);
              setError(null);
            }}
            className={segCls(tab === k)}
          >
            {t(`connectors.add.tab.${k}`)}
          </button>
        ))}
        <button
          type="button"
          data-action="add-cancel"
          onClick={onCancel}
          className="ml-auto rounded px-2 py-0.5 text-text-muted hover:bg-surface-raised"
        >
          {t("connectors.add.cancel")}
        </button>
      </div>
      {tab === "catalog" ? catalogPane : customPane}
      {error && (
        <p data-error className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
