"use client";

/**
 * Authenticates a model provider used by an NPC profile, in-app — for the gateway owner.
 *
 * There are three cases by `authType`.
 * - `oauth_device`: login -> shows a code and verification-page link, and polls the session until approved.
 * - `api_key`: write-only key input. The value is sent to the server and never read back.
 * - `external`: a login that can't be done from the app — only guides the command to run on the gateway host.
 * When `authType` is absent (an old plugin, or an unknown provider), nothing is rendered.
 *
 * Secret-value rule: the key input field is uncontrolled. A controlled input has React sync
 * even the `value` **attribute**, which puts the key into the DOM serialization (innerHTML)
 * — the value lives only in the input's property, and is cleared on a successful save. It's
 * never sent to logs, and failure text is localized only from codes (never the raw upstream
 * `error`).
 *
 * Polling rule: a `setTimeout` chain — the next poll is scheduled only after a response
 * arrives, so they never overlap. Cancel/unmount clears the timer and DELETEs a live session
 * exactly once. A session the upstream already ended (approved/denied/expired) is not deleted.
 */
import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  type FormEvent,
  type JSX,
} from "react";

import { CopyCommand } from "@/components/CopyCommand";
import { useT } from "@/lib/i18n";
import { getLocalizedErrorMessage, isErrorCode } from "@/lib/i18n/error-codes";
import type {
  OAuthPollPayload,
  OAuthStartPayload,
  ProviderAuthType,
} from "@/lib/hermes/plugin-client-types";

import { isSafeHttpUrl, oauthReducer, pollDelayMs } from "./provider-auth-model";
import { SECRET_INPUT_PROPS } from "./secret-input";
import { getWizardErrorMessage, isWizardErrorCode } from "./wizard-error-codes";

/**
 * `provider.name` is never rendered here — the title/name is attached by the caller (this
 * panel only handles auth actions). Changing `profileBase`/`provider.id` restarts the whole
 * panel's state from scratch (see the default export below).
 */
export type ProviderAuthPanelProps = {
  profileBase: string; // `/api/gateways/${gatewayId}/plugin/profiles/${encodeURIComponent(name)}`
  provider: {
    id: string;
    name: string;
    authenticated: boolean;
    authType?: ProviderAuthType;
    envVars?: string[];
    cliCommand?: string | null;
  };
  onAuthenticated(): void; // after a successful login/key save/disconnect — the caller refetches the catalog
  disabled?: boolean;
};

type Body = Record<string, unknown>;
type Translator = ReturnType<typeof useT>;

const TERMINAL_STATUSES: ReadonlyArray<OAuthPollPayload["status"]> = [
  "approved",
  "denied",
  "expired",
  "error",
];
/** Transient failures the proxy carries as HTTP 200 + errorCode — retried until expiry, like a network failure. */
const TRANSIENT_POLL_CODES: ReadonlySet<string> = new Set([
  "timeout",
  "unreachable",
  "upstream_error",
]);
/** Prevents polling forever while the network is down and no poll response arrives — expiry time + grace period. */
const EXPIRY_GRACE_MS = 30_000;

const BTN =
  "rounded bg-surface-raised px-3 py-1.5 text-xs font-semibold text-text hover:bg-surface-raised/80 disabled:opacity-50";
const BTN_PRIMARY =
  "rounded bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50";
const BADGE = "rounded bg-surface-raised px-1.5 py-0.5 text-[10px] text-text-muted";

/** Flows as `malformed_response` when the body isn't a JSON object (same as ToolsetSkillPicker). */
async function readBody(response: Response): Promise<Body> {
  try {
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return { errorCode: "malformed_response" };
    }
    return body as Body;
  } catch {
    return { errorCode: "malformed_response" };
  }
}

/** An upstream failure arrives as HTTP 200 + `errorCode` — the status code alone isn't checked. */
function succeeded(response: Response, body: Body): boolean {
  return response.ok && typeof body.errorCode !== "string";
}

function errorCodeOf(body: Body | null, fallback: string): string {
  return body && typeof body.errorCode === "string" ? body.errorCode : fallback;
}

/**
 * Code -> localized text. A proxy code (`timeout`/`unreachable`/`upstream_error`, ...) that's
 * absent from the common table (`error-codes.ts`) but present in the wizard table is routed
 * there. Falls back if it's in neither.
 */
function errorText(t: Translator, code: string, fallbackKey: string): string {
  if (!isErrorCode(code) && isWizardErrorCode(code)) return getWizardErrorMessage(t, code);
  return getLocalizedErrorMessage(t, { errorCode: code }, fallbackKey);
}

/** The auth state to show after success, until the caller refetches the catalog. `base` is
 *  the prop value at that time — when the prop changes (a refetch happened), the override
 *  value retires on its own. */
type Override = { base: boolean; value: boolean } | null;

/**
 * Remounts the inner panel fresh for every target (`profileBase`/`provider.id`). If state
 * carried over, a key already typed could be PUT to a **different** provider's endpoint, an
 * in-progress login could poll an old session on a new path, or a "connected" override could
 * be left on the wrong provider. Changing the key unmounts the old panel, DELETEs any live
 * session exactly once, and clears the input field along with it.
 */
export default function ProviderAuthPanel(props: ProviderAuthPanelProps): JSX.Element | null {
  return <ProviderAuthPanelInner key={`${props.profileBase}|${props.provider.id}`} {...props} />;
}

function ProviderAuthPanelInner(props: ProviderAuthPanelProps): JSX.Element | null {
  const t = useT();
  const { profileBase, provider, disabled = false } = props;
  const providerPath = `${profileBase}/oauth/${encodeURIComponent(provider.id)}`;
  const keyPath = `${profileBase}/provider-keys/${encodeURIComponent(provider.id)}`;

  const [oauth, dispatch] = useReducer(oauthReducer, { kind: "idle" });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState(false);
  const [hasKeyValue, setHasKeyValue] = useState(false);
  const [override, setOverride] = useState<Override>(null);
  const keyInput = useRef<HTMLInputElement | null>(null);

  const connected =
    override && override.base === provider.authenticated ? override.value : provider.authenticated;

  // The latest prop is kept in a ref so polling isn't re-scheduled even if the parent passes a new inline function.
  const latest = useRef({
    onAuthenticated: props.onAuthenticated,
    profileBase,
    authenticated: provider.authenticated,
  });
  useEffect(() => {
    latest.current = {
      onAuthenticated: props.onAuthenticated,
      profileBase,
      authenticated: provider.authenticated,
    };
  });

  /** The live session that needs a DELETE. Once cleared, it's never deleted again — DELETE happens exactly once. */
  const liveSession = useRef<string | null>(null);
  const pollDelay = useRef(pollDelayMs(undefined));
  const unmounted = useRef(false);

  const releaseSession = useCallback(() => {
    const sessionId = liveSession.current;
    if (!sessionId) return;
    liveSession.current = null;
    void fetch(`${latest.current.profileBase}/oauth/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
    }).catch(() => {
      // Even if the delete fails, the session still expires upstream — there's nothing for the screen to report.
    });
  }, []);

  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
      releaseSession();
    };
  }, [releaseSession]);

  const markAuthenticated = useCallback((value: boolean) => {
    setOverride({ base: latest.current.authenticated, value });
    latest.current.onAuthenticated();
  }, []);

  // ── OAuth polling ────────────────────────────────────────────────────────
  const waitingSession = oauth.kind === "waiting" ? oauth.sessionId : null;
  const waitingExpiresAt = oauth.kind === "waiting" ? oauth.expiresAt : 0;

  useEffect(() => {
    if (!waitingSession) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const url = `${providerPath}/sessions/${encodeURIComponent(waitingSession)}`;

    const schedule = (delay: number) => {
      timer = setTimeout(() => void tick(), delay);
    };

    async function tick() {
      let response: Response | null = null;
      let body: Body = {};
      try {
        response = await fetch(url);
        body = await readBody(response);
      } catch {
        response = null; // A transient network failure — retried until expiry.
      }
      if (stopped) return;

      const transient =
        !response ||
        (!succeeded(response, body) &&
          typeof body.errorCode === "string" &&
          TRANSIENT_POLL_CODES.has(body.errorCode));
      if (transient) {
        if (Date.now() > waitingExpiresAt + EXPIRY_GRACE_MS) {
          releaseSession();
          dispatch({ type: "poll", status: "expired", error: null });
          return;
        }
        schedule(pollDelay.current);
        return;
      }
      if (!response || !succeeded(response, body)) {
        releaseSession();
        dispatch({ type: "fail", errorCode: errorCodeOf(body, "oauth_error") });
        return;
      }

      const status = body.status as OAuthPollPayload["status"] | undefined;
      if (status === "pending") {
        const retryAfter = typeof body.retryAfter === "number" ? body.retryAfter * 1000 : 0;
        schedule(Math.max(pollDelay.current, retryAfter));
        return;
      }
      if (status && TERMINAL_STATUSES.includes(status)) {
        // A session the upstream already ended — nothing to delete.
        liveSession.current = null;
        dispatch({ type: "poll", status, error: null });
        if (status === "approved") markAuthenticated(true);
        return;
      }
      releaseSession();
      dispatch({ type: "fail", errorCode: "malformed_response" });
    }

    schedule(pollDelay.current);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [waitingSession, waitingExpiresAt, providerPath, releaseSession, markAuthenticated]);

  const startLogin = async () => {
    setActionError(null);
    dispatch({ type: "start" });
    let ok = false;
    let body: Body = {};
    try {
      const response = await fetch(`${providerPath}/start`, { method: "POST" });
      body = await readBody(response);
      ok = succeeded(response, body);
    } catch {
      // A network failure — falls through to oauth_error below.
    }
    const start = body as Partial<OAuthStartPayload>;
    // If a session was created upstream, grab it first — so it can be cleaned up even if
    // the screen already closed or the response shape is wrong.
    if (ok && typeof start.sessionId === "string" && start.sessionId !== "") {
      liveSession.current = start.sessionId;
    }
    if (unmounted.current) {
      releaseSession();
      return;
    }
    if (!ok) {
      dispatch({ type: "fail", errorCode: errorCodeOf(body, "oauth_error") });
      return;
    }
    if (
      typeof start.sessionId !== "string" ||
      start.sessionId === "" ||
      typeof start.userCode !== "string" ||
      typeof start.verificationUrl !== "string"
    ) {
      releaseSession();
      dispatch({ type: "fail", errorCode: "malformed_response" });
      return;
    }
    pollDelay.current = pollDelayMs(start.pollInterval);
    dispatch({
      type: "started",
      sessionId: start.sessionId,
      userCode: start.userCode,
      verificationUrl: start.verificationUrl,
      expiresIn: typeof start.expiresIn === "number" ? start.expiresIn : 900,
      now: Date.now(),
    });
  };

  const cancelLogin = () => {
    releaseSession();
    dispatch({ type: "cancel" });
  };

  /** Shared skeleton for disconnect/save key/remove key. Returns the response body on success, null on failure. */
  const mutate = async (url: string, init: RequestInit): Promise<Body | null> => {
    setBusy(true);
    setActionError(null);
    try {
      const response = await fetch(url, init);
      const body = await readBody(response);
      if (unmounted.current) return null;
      if (!succeeded(response, body)) {
        setActionError(errorCodeOf(body, "unknown"));
        return null;
      }
      return body;
    } catch {
      if (!unmounted.current) setActionError("unknown");
      return null;
    } finally {
      if (!unmounted.current) setBusy(false);
    }
  };

  const disconnect = async () => {
    const body = await mutate(providerPath, { method: "DELETE" });
    if (!body) return;
    dispatch({ type: "cancel" });
    // ok:false means that profile's auth.json had nothing to remove (auth can come from an
    // env var or pool) — this doesn't overwrite it as disconnected, it just shows the
    // refetched catalog state as-is.
    if (body.ok === false) latest.current.onAuthenticated();
    else markAuthenticated(false);
  };

  const saveKey = async (event: FormEvent) => {
    event.preventDefault();
    const input = keyInput.current;
    const value = input?.value ?? "";
    if (!value) return;
    const ok =
      (await mutate(keyPath, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value }),
      })) !== null;
    if (!ok) return;
    if (input) input.value = "";
    setHasKeyValue(false);
    setEditingKey(false);
    markAuthenticated(true);
  };

  const removeKey = async () => {
    if ((await mutate(keyPath, { method: "DELETE" })) !== null) {
      setEditingKey(false);
      markAuthenticated(false);
    }
  };

  const actionErrorLine = actionError && (
    <p className="text-sm text-danger">
      {errorText(t, actionError, "hermes.providerAuth.actionFailed")}
    </p>
  );
  const connectedBadge = <span className={BADGE}>{t("hermes.providerAuth.connected")}</span>;

  // ── external ─────────────────────────────────────────────────────────────
  if (provider.authType === "external") {
    if (!connected && !provider.cliCommand) return null;
    return (
      <div className="space-y-2">
        {connected && <div>{connectedBadge}</div>}
        {provider.cliCommand && (
          <>
            <p className="text-xs text-text-muted">{t("hermes.providerAuth.cliHint")}</p>
            <CopyCommand command={provider.cliCommand} />
          </>
        )}
      </div>
    );
  }

  // ── oauth_device ─────────────────────────────────────────────────────────
  if (provider.authType === "oauth_device") {
    const inFlow = oauth.kind === "starting" || oauth.kind === "waiting";
    if (connected && !inFlow) {
      return (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            {connectedBadge}
            <button
              type="button"
              className={BTN}
              disabled={disabled || busy}
              onClick={() => void disconnect()}
            >
              {t("hermes.providerAuth.disconnect")}
            </button>
          </div>
          {actionErrorLine}
        </div>
      );
    }

    if (oauth.kind === "waiting") {
      return (
        <div className="space-y-2 rounded border border-border p-3">
          <p className="text-xs text-text-muted">{t("hermes.providerAuth.enterCode")}</p>
          <p className="font-mono text-lg font-semibold tracking-widest text-text select-all">
            {oauth.userCode}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {isSafeHttpUrl(oauth.verificationUrl) && (
              <a
                href={oauth.verificationUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={BTN_PRIMARY}
              >
                {t("hermes.providerAuth.openVerification")}
              </a>
            )}
            <button type="button" className={BTN} disabled={disabled} onClick={cancelLogin}>
              {t("hermes.providerAuth.cancel")}
            </button>
          </div>
          <p className="text-xs text-text-muted">{t("hermes.providerAuth.waiting")}</p>
        </div>
      );
    }

    if (oauth.kind === "failed") {
      return (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-danger">
            {errorText(t, oauth.errorCode, "hermes.providerAuth.failed.oauth_error")}
          </p>
          <button
            type="button"
            className={BTN}
            disabled={disabled}
            onClick={() => void startLogin()}
          >
            {t("hermes.providerAuth.retry")}
          </button>
        </div>
      );
    }

    return (
      <button
        type="button"
        className={BTN_PRIMARY}
        disabled={disabled || oauth.kind === "starting"}
        onClick={() => void startLogin()}
      >
        {t("hermes.providerAuth.login")}
      </button>
    );
  }

  // ── api_key ──────────────────────────────────────────────────────────────
  if (provider.authType === "api_key") {
    if (connected && !editingKey) {
      return (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            {connectedBadge}
            <button
              type="button"
              className={BTN}
              disabled={disabled || busy}
              onClick={() => {
                setActionError(null);
                setEditingKey(true);
              }}
            >
              {t("hermes.providerAuth.replaceKey")}
            </button>
            <button
              type="button"
              className={BTN}
              disabled={disabled || busy}
              onClick={() => void removeKey()}
            >
              {t("hermes.providerAuth.removeKey")}
            </button>
          </div>
          {actionErrorLine}
        </div>
      );
    }

    const envVar = provider.envVars?.[0];
    return (
      <form className="space-y-2" onSubmit={(e) => void saveKey(e)}>
        <label className="block space-y-1">
          <span className="text-xs font-semibold text-text">
            {t("hermes.providerAuth.keyLabel")}
            {envVar && <span className="ml-2 font-mono font-normal text-text-muted">{envVar}</span>}
          </span>
          <input
            ref={keyInput}
            {...SECRET_INPUT_PROPS}
            placeholder={t("hermes.providerAuth.keyPlaceholder")}
            disabled={disabled || busy}
            onChange={(e) => setHasKeyValue(e.target.value !== "")}
            className="w-full rounded border border-border bg-bg px-3 py-2 text-sm text-text focus:outline-none focus:border-indigo-500"
          />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" className={BTN_PRIMARY} disabled={disabled || busy || !hasKeyValue}>
            {t("hermes.providerAuth.saveKey")}
          </button>
          {connected && (
            <>
              <button
                type="button"
                className={BTN}
                disabled={disabled || busy}
                onClick={() => {
                  if (keyInput.current) keyInput.current.value = "";
                  setHasKeyValue(false);
                  setEditingKey(false);
                }}
              >
                {t("hermes.providerAuth.cancel")}
              </button>
              <button
                type="button"
                className={BTN}
                disabled={disabled || busy}
                onClick={() => void removeKey()}
              >
                {t("hermes.providerAuth.removeKey")}
              </button>
            </>
          )}
        </div>
        {actionErrorLine}
      </form>
    );
  }

  return null;
}
