"use client";

/**
 * SSH host registration — shows the public key of DeskRPG's dedicated key, and pins the
 * host key only after its fingerprint is confirmed.
 *
 * 1. Copy the public key → an admin appends it to the target server's `~/.ssh/authorized_keys`
 *    (the private key never leaves the server).
 * 2. Enter host/port/user → the server shows the fingerprint it got from `ssh-keyscan`.
 * 3. Confirm "the fingerprint matches" → the server scans again and registers only if it matches.
 *
 * Admin-only (the server decides). No password is accepted.
 */
import { useEffect, useState, type JSX } from "react";

import { CopyCommand } from "@/components/CopyCommand";
import { useLocale, useT } from "@/lib/i18n";

import { setupCopy, setupError } from "./setup-copy";

const API = "/api/gateways/setup";
const button =
  "rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-hover disabled:opacity-50";
const secondary =
  "rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-surface-raised disabled:opacity-50";
const input =
  "w-full rounded border border-border bg-bg px-3 py-2 text-text focus:outline-none focus:border-primary";

type ScannedKey = { type: string; fingerprint: string };

/** Codes commonly seen during registration spell out what to do about them. Everything else uses the wizard's common text. */
const SSH_ERROR_KEYS: Record<string, string> = {
  ssh_connection_failed: "hermes.wizard.ssh.errors.unreachable",
  ssh_unavailable: "hermes.wizard.ssh.errors.noTools",
  ssh_host_key_failed: "hermes.wizard.ssh.errors.keyChanged",
  setup_invalid_request: "hermes.wizard.ssh.errors.invalid",
};

function errorCode(err: unknown): string | undefined {
  const code = (err as { errorCode?: unknown } | null)?.errorCode;
  return typeof code === "string" ? code : undefined;
}

async function post<T>(body: object): Promise<T> {
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw data;
  return data as T;
}

/** The command to run once on the target server — appends the public key to authorized_keys. */
export function authorizeCommand(publicKey: string): string {
  const quoted = `'${publicKey.replace(/'/g, "'\\''")}'`;
  return `mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo ${quoted} >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`;
}

type RegistrationProps = {
  onRegistered(host: { id: string; label: string }): void;
  onCancel?(): void;
};

/**
 * Accepts both methods (Dante's decision, 2026-09-19).
 * - My SSH config: same as Hermes Desktop. Uses the server user's `~/.ssh/config`/agent/key
 *   files. Only when `~/.ssh` exists.
 * - DeskRPG's dedicated key: plants the public key on the target server. Works even without
 *   `~/.ssh`, like in a container.
 */
export default function SshHostRegistration(props: RegistrationProps): JSX.Element {
  const t = useT();
  const [info, setInfo] = useState<{ available: boolean; aliases: string[] } | null>(null);
  const [method, setMethod] = useState<"system" | "managed" | null>(null);
  useEffect(() => {
    let cancelled = false;
    post<{ available: boolean; aliases: string[] }>({ action: "ssh-system-info" })
      .then((data) => !cancelled && setInfo(data))
      .catch(() => !cancelled && setInfo({ available: false, aliases: [] }));
    return () => {
      cancelled = true;
    };
  }, []);
  if (!info) return <p className="text-sm text-text-muted">{t("common.loading")}</p>;
  const chosen = method ?? (info.available ? "system" : "managed");
  return (
    <div className="space-y-3">
      {info.available && (
        <div className="flex gap-2" role="tablist" data-ssh-method>
          {(["system", "managed"] as const).map((m) => (
            <button
              key={m}
              role="tab"
              aria-selected={chosen === m}
              className={chosen === m ? button : secondary}
              onClick={() => setMethod(m)}
            >
              {t(
                m === "system"
                  ? "hermes.wizard.ssh.methodSystem"
                  : "hermes.wizard.ssh.methodManaged",
              )}
            </button>
          ))}
        </div>
      )}
      {chosen === "system" ? (
        <SystemSshRegistration aliases={info.aliases} {...props} />
      ) : (
        <ManagedKeyRegistration {...props} />
      )}
    </div>
  );
}

const SYSTEM_ERROR_KEYS: Record<string, string> = {
  ...SSH_ERROR_KEYS,
  ssh_auth_failed: "hermes.wizard.ssh.errors.systemAuth",
  ssh_key_not_found: "hermes.wizard.ssh.errors.keyNotFound",
  ssh_host_key_failed: "hermes.wizard.ssh.errors.systemKeyChanged",
  setup_invalid_request: "hermes.wizard.ssh.errors.systemInvalid",
};

/** The Desktop method — alias (recommended)/host, optional user/port/key path. Saved only after a successful test connection. */
function SystemSshRegistration({
  aliases,
  onRegistered,
  onCancel,
}: RegistrationProps & { aliases: string[] }): JSX.Element {
  const t = useT();
  const { locale } = useLocale();
  const [target, setTarget] = useState("");
  const [user, setUser] = useState("");
  const [port, setPort] = useState("");
  const [keyPath, setKeyPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      const data = await post<{ host: { id: string; label: string } }>({
        action: "ssh-system-add",
        target: target.trim(),
        user: user.trim(),
        port: port.trim(),
        keyPath: keyPath.trim(),
      });
      onRegistered(data.host);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const code = errorCode(error) ?? "";
  return (
    <div className="space-y-3 rounded-lg border border-border bg-bg p-4" data-ssh-system>
      <p className="text-sm text-text-muted">{t("hermes.wizard.ssh.systemBody")}</p>
      <label className="block space-y-1 text-sm">
        <span className="font-semibold">{t("hermes.wizard.ssh.systemTarget")}</span>
        <input
          className={input}
          name="ssh-system-target"
          list="ssh-config-aliases"
          placeholder={t("hermes.wizard.ssh.systemTargetPlaceholder")}
          value={target}
          onChange={(e) => setTarget(e.target.value)}
        />
        <datalist id="ssh-config-aliases">
          {aliases.map((a) => (
            <option key={a} value={a} />
          ))}
        </datalist>
      </label>
      <div className="grid gap-2 sm:grid-cols-[10rem_6rem_1fr]">
        <input
          className={input}
          name="ssh-system-user"
          placeholder={t("hermes.wizard.ssh.systemUserPlaceholder")}
          value={user}
          onChange={(e) => setUser(e.target.value)}
        />
        <input
          className={input}
          name="ssh-system-port"
          inputMode="numeric"
          placeholder="22"
          value={port}
          onChange={(e) => setPort(e.target.value)}
        />
        <input
          className={input}
          name="ssh-system-key"
          placeholder={t("hermes.wizard.ssh.systemKeyPlaceholder")}
          value={keyPath}
          onChange={(e) => setKeyPath(e.target.value)}
        />
      </div>
      <p className="text-xs text-text-muted">{t("hermes.wizard.ssh.systemHint")}</p>
      <div className="flex items-center gap-4">
        <button className={button} disabled={busy || !target.trim()} onClick={() => void add()}>
          {busy ? t("hermes.wizard.ssh.systemTesting") : t("hermes.wizard.ssh.systemAdd")}
        </button>
        {onCancel && (
          <button className="text-sm text-text-muted underline" onClick={onCancel}>
            {t("hermes.wizard.ssh.cancel")}
          </button>
        )}
      </div>
      {Boolean(error) && (
        <p role="alert" className="text-sm text-danger">
          {SYSTEM_ERROR_KEYS[code]
            ? t(SYSTEM_ERROR_KEYS[code])
            : setupError(setupCopy[locale], errorCode(error))}
        </p>
      )}
    </div>
  );
}

function ManagedKeyRegistration({ onRegistered, onCancel }: RegistrationProps): JSX.Element {
  const t = useT();
  const { locale } = useLocale();
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [user, setUser] = useState("");
  const [keys, setKeys] = useState<ScannedKey[] | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let cancelled = false;
    post<{ publicKey: string }>({ action: "ssh-public-key" })
      .then((data) => !cancelled && setPublicKey(data.publicKey))
      .catch((err) => !cancelled && setError(err));
    return () => {
      cancelled = true;
    };
  }, []);

  const target = { host: host.trim(), port: port.trim(), user: user.trim() };
  const ready = Boolean(target.host && target.user && /^\d{1,5}$/.test(target.port));

  const scan = async () => {
    setBusy(true);
    setError(null);
    setKeys(null);
    setConfirmed(false);
    try {
      const data = await post<{ keys: ScannedKey[] }>({ action: "ssh-scan", ...target });
      setKeys(data.keys);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const register = async () => {
    if (!keys) return;
    setBusy(true);
    setError(null);
    try {
      const data = await post<{ host: { id: string; label: string } }>({
        action: "ssh-register",
        ...target,
        fingerprints: keys.map((k) => k.fingerprint),
      });
      onRegistered(data.host);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4 rounded-lg border border-border bg-bg p-4" data-ssh-registration>
      <div className="space-y-2">
        <h3 className="font-semibold">{t("hermes.wizard.ssh.keyTitle")}</h3>
        <p className="text-sm text-text-muted">{t("hermes.wizard.ssh.keyBody")}</p>
        {publicKey ? (
          <CopyCommand command={authorizeCommand(publicKey)} />
        ) : (
          !error && <p className="text-sm text-text-muted">{t("common.loading")}</p>
        )}
      </div>

      <div className="space-y-2">
        <h3 className="font-semibold">{t("hermes.wizard.ssh.hostTitle")}</h3>
        <div className="grid gap-2 sm:grid-cols-[1fr_6rem_10rem]">
          <input
            className={input}
            name="ssh-host"
            placeholder={t("hermes.wizard.ssh.hostPlaceholder")}
            value={host}
            onChange={(e) => {
              setHost(e.target.value);
              setKeys(null);
            }}
          />
          <input
            className={input}
            name="ssh-port"
            inputMode="numeric"
            placeholder="22"
            value={port}
            onChange={(e) => {
              setPort(e.target.value);
              setKeys(null);
            }}
          />
          <input
            className={input}
            name="ssh-user"
            placeholder={t("hermes.wizard.ssh.userPlaceholder")}
            value={user}
            onChange={(e) => {
              setUser(e.target.value);
              setKeys(null);
            }}
          />
        </div>
        <button className={secondary} disabled={busy || !ready} onClick={() => void scan()}>
          {busy && !keys ? t("hermes.wizard.ssh.scanning") : t("hermes.wizard.ssh.scan")}
        </button>
      </div>

      {keys && (
        <div className="space-y-2" data-ssh-fingerprints>
          <p className="text-sm text-text">{t("hermes.wizard.ssh.fingerprintBody")}</p>
          <ul className="space-y-1 font-mono text-xs">
            {keys.map((k) => (
              <li key={k.fingerprint}>
                {k.type} <span className="text-text">{k.fingerprint}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-text-muted">{t("hermes.wizard.ssh.fingerprintHow")}</p>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              name="ssh-fingerprint-confirm"
              className="mt-1 accent-primary"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            <span>{t("hermes.wizard.ssh.fingerprintConfirm")}</span>
          </label>
          <button className={button} disabled={busy || !confirmed} onClick={() => void register()}>
            {t("hermes.wizard.ssh.register")}
          </button>
        </div>
      )}

      {Boolean(error) && (
        <p role="alert" className="text-sm text-danger">
          {SSH_ERROR_KEYS[errorCode(error) ?? ""]
            ? t(SSH_ERROR_KEYS[errorCode(error) ?? ""])
            : setupError(setupCopy[locale], errorCode(error))}
        </p>
      )}
      {onCancel && (
        <button className="text-sm text-text-muted underline" onClick={onCancel}>
          {t("hermes.wizard.ssh.cancel")}
        </button>
      )}
    </div>
  );
}
