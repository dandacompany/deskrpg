"use client";
import { useEffect, useRef, useState } from "react";
import { CheckCircle2, ExternalLink, Loader2 } from "lucide-react";

import { parseOAuthPaste } from "@/lib/mcp-oauth-paste";
import { useT } from "@/lib/i18n";

import { connectorErrorText } from "./connector-error-text";
import { ConnectorsApiError, type ConnectorsApi } from "./connectors-api";
import { CONNECTOR_OAUTH_TIMEOUT_MS, useConnectorJob } from "./use-connector-job";

export type ConnectorOAuthStepProps = {
  api: ConnectorsApi;
  server: string;
  onDone(): void;
  onCancel(): void;
};

/** The same trimming `parseOAuthPaste` applies, so the server receives what was checked. */
const cleanPaste = (raw: string) =>
  raw
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .trim();

/**
 * OAuth by pasting the loopback redirect URL. Hermes pins the redirect to
 * `http://127.0.0.1:8412/callback`, so after approving, the user's browser lands on a "can't
 * connect" page; its address holds `code`/`state`. The address is checked here as it is typed
 * (instant feedback) and again on the server, then the session is polled until Hermes finishes.
 * Leaving the step while a session is open cancels it.
 */
export default function ConnectorOAuthStep({
  api,
  server,
  onDone,
  onCancel,
}: ConnectorOAuthStepProps) {
  const t = useT();
  const [session, setSession] = useState<{ sessionId: string; authUrl: string } | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [paste, setPaste] = useState("");
  const [busy, setBusy] = useState(false);
  const [approved, setApproved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The plugin reported an open attempt this screen did not start (409 oauth_in_progress).
  const [foreign, setForeign] = useState(false);
  const job = useConnectorJob({ timeoutMs: CONNECTOR_OAUTH_TIMEOUT_MS });
  // The open session to cancel on unmount — cleared once approved or cancelled.
  const openSession = useRef<string | null>(null);
  const cancel = useRef<ConnectorsApi["oauthCancel"]>(api.oauthCancel);
  cancel.current = api.oauthCancel;
  const done = useRef(onDone);
  done.current = onDone;
  const pasteInput = useRef<HTMLInputElement>(null);

  // Step 2 is easy to miss once the provider tab opens — move the caret straight to the paste field.
  useEffect(() => {
    if (session) pasteInput.current?.focus();
  }, [session]);

  useEffect(
    () => () => {
      const sid = openSession.current;
      openSession.current = null;
      if (sid) void cancel.current(sid).catch(() => {});
    },
    [],
  );

  const finish = () => {
    openSession.current = null;
    setApproved(true);
    done.current();
  };

  const start = async (restartOpen = false) => {
    setBusy(true);
    setError(null);
    setPaste("");
    setBlocked(false);
    job.stop();
    try {
      const res = await api.oauthStart(server, restartOpen);
      if ("status" in res) {
        finish();
        return;
      }
      openSession.current = res.sessionId;
      setSession(res);
      // Opened without `noopener` so a blocked popup is detectable (`noopener` always yields
      // null); the opener link is cut by hand instead.
      const w = window.open(res.authUrl, "_blank");
      if (w) w.opener = null;
      else setBlocked(true);
    } catch (e) {
      // An attempt this screen does not know about (another tab, or before a reload) is still open —
      // offer [Restart], which asks the plugin to end it first.
      if (e instanceof ConnectorsApiError && e.code === "oauth_in_progress") setForeign(true);
      setError(connectorErrorText(t, e));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Ends the open attempt before starting a new one. The plugin (0.17.1 `restart`) cancels it and waits
   * for its worker to finish — overlapping attempts race in Hermes and can wipe a fresh token.
   */
  const restart = async () => {
    openSession.current = null;
    setSession(null);
    setForeign(false);
    job.stop();
    await start(true);
  };

  const submit = async () => {
    if (!session) return;
    const sid = session.sessionId;
    setBusy(true);
    setError(null);
    try {
      await api.oauthCallback(sid, cleanPaste(paste));
    } catch (e) {
      setError(connectorErrorText(t, e));
      setBusy(false);
      return;
    }
    setBusy(false);
    job.start(async () => {
      const poll = await api.oauthPoll(sid);
      if (poll.status === "approved") {
        finish();
        return { done: true };
      }
      if (poll.status === "error") {
        openSession.current = null;
        setSession(null);
        setError(t("connectors.oauth.failed", { detail: poll.error ?? "" }));
        return { done: true };
      }
      return { done: false };
    });
  };

  const parsed = paste.trim() ? parseOAuthPaste(paste) : null;
  const waiting = job.state === "running";
  const canSubmit = !!session && parsed?.ok === true && !busy && !waiting && !approved;
  const inProgress = (!!session || foreign) && !approved;

  return (
    <div className="flex max-w-xl flex-col gap-3 text-sm">
      <p className="text-xs text-text-muted">{t("connectors.oauth.intro")}</p>
      {!approved && (
        <p className="text-xs font-semibold text-text">{t("connectors.oauth.step1")}</p>
      )}
      {!approved && (
        <button
          type="button"
          data-action="oauth-start"
          disabled={busy || waiting || inProgress}
          onClick={() => void start()}
          className="flex items-center gap-1 self-start rounded bg-primary px-3 py-1 text-white disabled:opacity-50"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          {t("connectors.oauth.start")}
        </button>
      )}
      {inProgress && (
        <p data-oauth-in-progress className="flex items-center gap-2 text-xs text-text-muted">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <span>{t("connectors.oauth.inProgress")}</span>
          <button
            type="button"
            data-action="oauth-restart"
            disabled={busy}
            onClick={() => void restart()}
            className="text-primary disabled:opacity-50"
          >
            {t("connectors.oauth.restart")}
          </button>
        </p>
      )}
      {session && blocked && (
        <p className="text-xs text-text-muted">
          {t("connectors.oauth.popupBlocked")}{" "}
          <a
            data-oauth-link
            href={session.authUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="break-all text-primary underline"
          >
            {session.authUrl}
          </a>
        </p>
      )}
      {session && !approved && (
        <form
          className="flex flex-col gap-1 rounded border-2 border-primary p-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit) void submit();
          }}
        >
          <p data-oauth-step2 className="text-sm font-semibold text-primary">
            {t("connectors.oauth.step2")}
          </p>
          <label className="flex flex-col gap-0.5 text-xs text-text-muted">
            {t("connectors.oauth.pasteLabel")}
            <input
              ref={pasteInput}
              name="oauth-paste"
              value={paste}
              autoComplete="off"
              spellCheck={false}
              placeholder="http://127.0.0.1:8412/callback?code=…&state=…"
              onChange={(e) => setPaste(e.target.value)}
              className="min-w-0 rounded bg-surface-raised px-2 py-1 font-mono text-xs text-text"
            />
          </label>
          {parsed && !parsed.ok && (
            <p data-paste-invalid className="text-xs text-danger">
              {parsed.reason === "denied"
                ? t("connectors.oauth.denied", { detail: parsed.error ?? "" })
                : t("connectors.oauth.pasteInvalid")}
            </p>
          )}
          <div className="flex gap-2">
            <button
              type="submit"
              data-action="oauth-submit"
              disabled={!canSubmit}
              className="rounded bg-primary px-3 py-1 text-white disabled:opacity-50"
            >
              {t("connectors.oauth.submit")}
            </button>
            <button
              type="button"
              data-action="oauth-cancel"
              onClick={onCancel}
              className="rounded px-3 py-1 text-text-muted hover:bg-surface-raised"
            >
              {t("connectors.oauth.cancel")}
            </button>
          </div>
        </form>
      )}
      {waiting && (
        <p className="flex items-center gap-1.5 text-xs text-text-muted">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t("connectors.oauth.waiting")}
        </p>
      )}
      {job.state === "timeout" && (
        <p className="text-xs text-danger">{t("connectors.oauth.timedOut")}</p>
      )}
      {job.state === "failed" && !error && (
        <p className="text-xs text-danger">{t("connectors.error.action")}</p>
      )}
      {approved && (
        <p data-oauth-done className="flex items-center gap-1.5 text-xs text-text">
          <CheckCircle2 className="h-3.5 w-3.5 text-primary" />
          {t("connectors.oauth.done")}
        </p>
      )}
      {error && (
        <p data-error className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
