"use client";

import { useEffect, useRef, useState } from "react";
import { Globe, Monitor, Server, Terminal } from "lucide-react";
import { useLocale, useT } from "../../lib/i18n";
import type {
  SetupCapabilities,
  SetupCandidate,
  SetupInspection,
  SetupJob,
} from "../../lib/hermes/setup/types";
import {
  setupCopy,
  setupError,
  setupStep,
  setupHostError,
  setupWarning,
  setupProgress,
  isSetupWarningBlocking,
} from "./setup-copy";
import { PLUGIN_PIN_SHORT, PLUGIN_VERSION } from "../../lib/hermes/setup/pin";
import { WORKER_PROPAGATION_CONFIG_KEY } from "../../lib/hermes/deskrpg-plugin-types";
import {
  packageManagerFor,
  parseSystemPackages,
  systemPackagesCommand,
} from "../../lib/hermes/setup/system-packages";
import SshHostRegistration from "./SshHostRegistration";
import { CopyCommand } from "../CopyCommand";

const API = "/api/gateways/setup";
// Don't hand-copy the pinned commit/version — pin.ts is the source of truth and pin.test.ts checks it against the host script.
const PINNED_PLUGIN_COMMIT = PLUGIN_PIN_SHORT;
const PINNED_PLUGIN_VERSION = PLUGIN_VERSION;
const button =
  "rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-hover disabled:opacity-50";
const secondary =
  "rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-surface-raised disabled:opacity-50";
const input =
  "w-full rounded border border-border bg-bg px-3 py-2 text-text focus:outline-none focus:border-primary";
type Screen = "choice" | "remote" | "ssh" | "discover" | "review" | "job" | "url" | "success";
// Fields added by contract 2. types.ts is owned by the host side, so here we only widen the read.
// progress/completed added by contract 3 are widened the same way, for the same reason.
type WizardJob = SetupJob & {
  warnings?: string[];
  installerDigest?: string;
  progress?: string;
  completed?: string[];
};
// Steps that always rerun because state can change even on resume — never render them as "skipped".
const ALWAYS_RERUN = new Set(["verifying_gateway", "checking_model"]);
type ModelState = "ready" | "missing" | "unknown";
type WizardCapabilities = SetupCapabilities & { canInstallHermes?: boolean };
// Contract: ^[a-z0-9][a-z0-9_-]{0,63}$ — the server re-validates, but the screen guides first.
const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PROFILE_DESCRIPTION_MAX = 200;
// Contract: a suggested port only ever comes from 8642–8699. The server filters to the same range.
const PORT_SUGGEST_MIN = 8642;
const PORT_SUGGEST_MAX = 8699;
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

export default function GatewaySetupWizard({
  onConnected,
  onSaved,
}: {
  onConnected: (gatewayId: string) => void;
  /** A gateway was saved — it is in the list even if the plugin isn't ready. */
  onSaved?: (gatewayId: string, pluginStatus: string) => void;
}) {
  const { locale } = useLocale();
  const t = useT();
  const c = setupCopy[locale];
  const errorMessage = (code: unknown) => setupHostError(locale, code) ?? setupError(c, code);
  const [cap, setCap] = useState<WizardCapabilities | null>(null);
  const [screen, setScreen] = useState<Screen>("choice");
  const [mode, setMode] = useState<"local" | "ssh">("local");
  const [hostId, setHostId] = useState("");
  // Did discovery **succeed**? A failure (SSH auth/connection error) does not mean "no Hermes" —
  // it must not offer to install.
  const [discovered, setDiscovered] = useState(false);
  // SSH host registration panel. Expanded from the start if there are no registered hosts at all.
  const [registering, setRegistering] = useState(false);
  const [detailOpen, setDetailOpen] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<SetupCandidate[]>([]);
  const [inspection, setInspection] = useState<SetupInspection | null>(null);
  const [selectedProfiles, setSelectedProfiles] = useState<string[]>([]);
  const [job, setJob] = useState<WizardJob | null>(null);
  // A warning that persists even when the job succeeds — carried through to the success screen without mixing it up with failure.
  const [warnings, setWarnings] = useState<string[]>([]);
  const [newProfileName, setNewProfileName] = useState("");
  const [newProfileDescription, setNewProfileDescription] = useState("");
  const [provisionKeys, setProvisionKeys] = useState<string[]>([]);
  // Off by default because it runs an external script on the server (unlike the timezone suggestion).
  const [installConsent, setInstallConsent] = useState(false);
  const [installerDigest, setInstallerDigest] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [errorCode, setErrorCode] = useState<unknown>(null);
  // The model state that was explicitly checked. null means it hasn't been checked yet, so it follows the existing warning rule.
  const [modelState, setModelState] = useState<ModelState | null>(null);
  const [modelChecking, setModelChecking] = useState(false);
  // The last candidate a connection was attempted on, and the prepare body — used by recheck and resume.
  const [lastCandidateId, setLastCandidateId] = useState<string | null>(null);
  // The alternate port the host picked. Only sent to the server when the user explicitly clicks the button.
  const [portSuggestion, setPortSuggestion] = useState<number | null>(null);
  const [portCandidateId, setPortCandidateId] = useState<string | null>(null);
  const [lastPrepare, setLastPrepare] = useState<Record<string, unknown> | null>(null);
  // Steps chosen to skip on resume (the `completed` list at request time).
  const [skippedSteps, setSkippedSteps] = useState<string[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState<{ gatewayId: string; pluginStatus: string } | null>(null);
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [displayName, setDisplayName] = useState("");
  // Read once: the browser's own zone is the only time-zone source the wizard has.
  const [browserTimezone] = useState(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    } catch {
      return "";
    }
  });
  const [sendTimezone, setSendTimezone] = useState(true);
  // Worker propagation (plugin 0.16.0 worker propagation). On by default — needed for Kanban/cron results to arrive (recommended).
  const [workerPropagation, setWorkerPropagation] = useState(true);
  const generation = useRef(0);
  // The job poll reads the callback through a ref so a new parent callback does not restart it.
  const onSavedRef = useRef(onSaved);
  useEffect(() => {
    onSavedRef.current = onSaved;
  }, [onSaved]);
  const controller = useRef<AbortController | null>(null);

  async function request<T>(body?: object, suffix = "", signal?: AbortSignal): Promise<T> {
    const res = await fetch(
      API + suffix,
      body
        ? {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal,
          }
        : { signal },
    );
    const data = await res.json();
    if (!res.ok)
      throw {
        errorCode: data.errorCode ?? "setup_failed",
        // Only carried on a port conflict. Treated as no suggestion if it isn't a number.
        suggestedPort: typeof data.suggestedPort === "number" ? data.suggestedPort : undefined,
      };
    return data;
  }
  useEffect(() => {
    const abort = new AbortController();
    request<WizardCapabilities>(undefined, "", abort.signal)
      .then(setCap)
      .catch(() => {
        if (!abort.signal.aborted) setErrorCode("setup_failed");
      });
    return () => {
      abort.abort();
      controller.current?.abort();
      // This counter invalidates pending requests; it is not a DOM ref.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      generation.current++;
    };
  }, []);

  function navigate(next: Screen) {
    generation.current++;
    controller.current?.abort();
    setBusy(false);
    setErrorCode(null);
    setPortSuggestion(null);
    setScreen(next);
    setToken("");
  }
  async function run<T>(job: (signal: AbortSignal) => Promise<T>, apply: (value: T) => void) {
    const epoch = ++generation.current;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setErrorCode(null);
    setPortSuggestion(null);
    try {
      const value = await job(abort.signal);
      if (epoch === generation.current) apply(value);
    } catch (error) {
      if (epoch === generation.current && !abort.signal.aborted) {
        const failed = error as { errorCode?: string; suggestedPort?: number };
        setErrorCode(failed?.errorCode ?? "setup_failed");
        // Discard if outside the suggestion range or not an integer — the flow continues even without a suggestion.
        setPortSuggestion(
          failed?.errorCode === "port_conflict" &&
            typeof failed.suggestedPort === "number" &&
            Number.isInteger(failed.suggestedPort) &&
            failed.suggestedPort >= PORT_SUGGEST_MIN &&
            failed.suggestedPort <= PORT_SUGGEST_MAX
            ? failed.suggestedPort
            : null,
        );
      }
    } finally {
      if (epoch === generation.current) setBusy(false);
    }
  }
  function discover(targetMode = mode) {
    setMode(targetMode);
    setScreen("discover");
    setDiscovered(false);
    setCandidates([]);
    setInspection(null);
    setJob(null);
    setNewProfileName("");
    setNewProfileDescription("");
    setProvisionKeys([]);
    setModelState(null);
    setSkippedSteps([]);
    setPortSuggestion(null);
    setPortCandidateId(null);
    void run(
      (signal) =>
        request<{ candidates: SetupCandidate[] }>(
          { action: "discover", mode: targetMode, ...(targetMode === "ssh" ? { hostId } : {}) },
          "",
          signal,
        ),
      (data) => {
        setCandidates(data.candidates);
        setDiscovered(true);
      },
    );
  }
  const target = { mode, ...(mode === "ssh" ? { hostId } : {}) };
  function inspect(candidateId: string) {
    // On conflict only the error remains, so remember which candidate it was at request time.
    setPortCandidateId(candidateId);
    void run(
      (signal) =>
        request<SetupInspection>({ action: "inspect", ...target, candidateId }, "", signal),
      (data) => {
        setInspection(data);
        setLastCandidateId(candidateId);
        setProvisionKeys([]);
        setSelectedProfiles(
          (data.profiles ?? [])
            .filter((profile) => profile.hasToken || profile.canProvision)
            .map((profile) => profile.name),
        );
        setScreen("review");
      },
    );
  }
  function acceptJob(next: WizardJob) {
    setJob(next);
    setWarnings(strings(next.warnings));
    if (typeof next.installerDigest === "string" && next.installerDigest)
      setInstallerDigest(next.installerDigest);
    if (next.status !== "running") setCancelling(false);
    if (next.status !== "succeeded") return;
    if (next.gatewayId) {
      setResult({ gatewayId: next.gatewayId, pluginStatus: "plugin_ready" });
      setScreen("success");
      onSavedRef.current?.(next.gatewayId, "plugin_ready");
      return;
    }
    // A job that finished without a gateway was an install-only job. The job screen shows it's done,
    // and continuing is the user's choice via "recheck" (auto-rediscovery would recreate a polling effect).
    setInstallConsent(false);
  }
  useEffect(() => {
    if (screen !== "job" || job?.status !== "running") return;
    const abort = new AbortController();
    const epoch = generation.current;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const data = await request<{ job: WizardJob }>(
          undefined,
          `?job=${encodeURIComponent(job.id)}`,
          abort.signal,
        );
        if (!abort.signal.aborted && epoch === generation.current) {
          setErrorCode(null);
          acceptJob(data.job);
        }
      } catch (error) {
        if (!abort.signal.aborted && epoch === generation.current)
          setErrorCode((error as { errorCode?: string }).errorCode ?? "setup_failed");
      }
      if (!abort.signal.aborted) timer = setTimeout(poll, 1200);
    };
    timer = setTimeout(poll, 500);
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [screen, job?.id, job?.status]);

  // Installation takes 3-6 minutes. Without a counting clock, the screen looks like it's frozen.
  const installingHermes =
    screen === "job" && job?.status === "running" && job.steps.at(-1) === "installing_hermes";
  useEffect(() => {
    if (!installingHermes) {
      setElapsed(0);
      return;
    }
    const started = Date.now();
    setElapsed(0);
    // Rounding, not flooring. Ticks land close to whole seconds, but setInterval (monotonic clock)
    // and Date.now (wall clock) can drift, so if the first tick reads as 999.x ms, flooring yields 0 —
    // the screen lags by one beat, and CI's "1 second elapsed" assertion flaked intermittently (2026-09-20).
    const timer = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    // Must stop when the step ends or the screen is left — otherwise it leaks a re-render every second.
    return () => clearInterval(timer);
  }, [installingHermes]);

  // An immediate response that doesn't create a job. No polling — just fetch a verdict and update the warning.
  function checkModel(candidateId: string) {
    const epoch = generation.current;
    const abort = new AbortController();
    setModelChecking(true);
    void request<{ model?: string }>(
      { action: "check-model", ...target, candidateId },
      "",
      abort.signal,
    )
      .then((data) => {
        if (epoch !== generation.current || abort.signal.aborted) return;
        const next = data.model;
        setModelState(
          next === "ready" || next === "missing" || next === "unknown" ? next : "unknown",
        );
      })
      .catch((error) => {
        if (epoch !== generation.current || abort.signal.aborted) return;
        setErrorCode((error as { errorCode?: string })?.errorCode ?? "setup_failed");
      })
      .finally(() => {
        if (epoch === generation.current) setModelChecking(false);
      });
  }

  // We need to hold onto the prepare body so that after a failure we can resume by just adding resumeFrom to the same request.
  function submitPrepare(body: Record<string, unknown>, resumeFrom?: string) {
    if (!resumeFrom) {
      setLastPrepare(body);
      setSkippedSteps([]);
    }
    void run(
      (signal) =>
        request<{ job: WizardJob }>(resumeFrom ? { ...body, resumeFrom } : body, "", signal),
      ({ job: next }) => {
        setScreen("job");
        acceptJob(next);
      },
    );
  }

  const card = (
    label: string,
    help: string,
    Icon: typeof Monitor,
    action: () => void,
    disabled = false,
  ) => (
    <button
      type="button"
      disabled={disabled}
      onClick={action}
      className="flex min-h-36 flex-col items-start gap-3 rounded-xl border border-border bg-bg p-5 text-left transition hover:border-primary hover:bg-primary/5 disabled:opacity-50"
    >
      <Icon aria-hidden="true" className="text-primary" size={28} />
      <span className="font-semibold">{label}</span>
      <span className="text-sm text-text-muted">{help}</span>
    </button>
  );
  const blockingWarning = inspection && isSetupWarningBlocking(inspection.candidate.warning);
  // Offer a zone only when the host has none and the browser actually knows one; never overwrite.
  const timezoneOffer =
    inspection && !inspection.candidate.timezone && browserTimezone ? browserTimezone : null;
  // It's a change if the host reported its current state and it differs from the chosen value. Always send it for an unknown host.
  const propagationChange =
    !!inspection &&
    inspection.candidate.workerPropagation !== (workerPropagation ? "enabled" : "disabled");
  const changeText = (change: string) =>
    change === "installing_service"
      ? t("hermes.wizard.review.serviceInstall")
      : change === "updating_plugin"
        ? t("hermes.wizard.review.pluginUpdate", { version: PINNED_PLUGIN_VERSION })
        : change === "setting_timezone" && (inspection?.candidate.timezone || browserTimezone)
          ? t("hermes.wizard.review.timezone", {
              timezone: inspection?.candidate.timezone || browserTimezone,
            })
          : setupStep(c, change);
  // Offer to install when Hermes wasn't found — both local and SSH. Availability follows the server's verdict (capabilities).
  const installOffered =
    (mode === "local" || mode === "ssh") && discovered && !busy && !candidates.length;
  const canInstallHermes =
    mode === "ssh" ? cap?.canInstallHermesSsh === true : cap?.canInstallHermes === true;
  // A message per block reason. Falls back to the old single sentence for an older server response with no reason.
  const hostReasonText = (reason: string | null | undefined) =>
    reason ? t(`hermes.wizard.hostReason.${reason}`) : c.unavailable;
  /**
   * A one-line block reason plus a `?` button when there's more to explain at length. Keep the
   * body short and only show the detailed circumstances on click (Dante's decision, 2026-09-19).
   * A reason with no detail text gets no button either.
   */
  const hostReasonNote = (reason: string | null | undefined) => {
    const detailKey = reason ? `hermes.wizard.hostReason.${reason}Detail` : "";
    const detail = detailKey ? t(detailKey) : "";
    const open = detailOpen === reason;
    return (
      <>
        <span>{hostReasonText(reason)}</span>
        {detail && detail !== detailKey && (
          <button
            type="button"
            aria-label={t("hermes.wizard.hostReason.more")}
            aria-expanded={open}
            data-reason-detail={reason}
            className="ml-2 inline-flex h-5 w-5 items-center justify-center rounded-full border border-border text-xs font-semibold text-text-muted hover:bg-surface-raised"
            onClick={() => setDetailOpen(open ? null : (reason ?? null))}
          >
            ?
          </button>
        )}
        {detail && open && <span className="mt-2 block text-text-muted">{detail}</span>}
      </>
    );
  };
  const trimmedProfileName = newProfileName.trim();
  const profileNameValid = !trimmedProfileName || PROFILE_NAME.test(trimmedProfileName);
  // A check outranks the warning: clear it if ready, add it (even if absent) if missing. unknown keeps the existing rule.
  const effectiveWarnings =
    modelState === "ready"
      ? warnings.filter((code) => code !== "model_provider_required")
      : modelState === "missing" && !warnings.includes("model_provider_required")
        ? [...warnings, "model_provider_required"]
        : warnings;
  const modelNote =
    modelState === "unknown"
      ? t("hermes.wizard.model.unknown")
      : modelState === "ready"
        ? t("hermes.wizard.model.ready")
        : null;
  const modelRecheck = lastCandidateId ? (
    <div className="space-y-2">
      {modelNote && (
        <p
          role="status"
          className="rounded-lg border border-border bg-bg p-3 text-sm text-text-muted"
        >
          {modelNote}
        </p>
      )}
      <button
        type="button"
        className={secondary}
        disabled={modelChecking}
        onClick={() => checkModel(lastCandidateId)}
      >
        {modelChecking ? t("hermes.wizard.model.checking") : t("hermes.wizard.model.recheck")}
      </button>
    </div>
  ) : null;
  const warningBanner = effectiveWarnings.length ? (
    <div className="space-y-2">
      {effectiveWarnings.map((code) => {
        const message = setupWarning(locale, code);
        return message ? (
          <p
            key={code}
            role="status"
            className="rounded-lg border border-primary/40 bg-primary/5 p-3 text-sm text-text"
          >
            {message}
          </p>
        ) : null;
      })}
    </div>
  ) : null;
  const digestLine = installerDigest ? (
    <p className="break-all text-xs text-text-muted">
      {t("hermes.wizard.install.digest", { digest: installerDigest })}
    </p>
  ) : null;
  const pluginLabel =
    inspection &&
    (inspection.pluginStatus === "plugin_unauthorized"
      ? c.unauthorized
      : inspection.pluginStatus === "plugin_ready"
        ? c.ready
        : !inspection.candidate.pluginInstalled
          ? c.pluginAbsent
          : !inspection.candidate.pluginEnabled
            ? c.disabled
            : inspection.candidate.warning === "gateway_unreachable"
              ? c.unreachable
              : ["pending_restart", "plugin_pending_restart"].includes(
                    inspection.candidate.warning ?? "",
                  )
                ? c.pending
                : c.unknown);

  return (
    <section className="rounded-xl border border-border bg-surface p-5" aria-label={c.title}>
      <h2 className="text-xl font-semibold">{c.title}</h2>
      {screen !== "choice" && screen !== "job" && screen !== "success" && (
        <button
          type="button"
          className={`${secondary} mt-4`}
          disabled={busy && (screen === "review" || screen === "url")}
          onClick={() =>
            navigate(
              screen === "remote" ||
                ((screen === "discover" || screen === "review") && mode === "local")
                ? "choice"
                : "remote",
            )
          }
        >
          {c.back}
        </button>
      )}
      {errorCode != null && (
        <p role="alert" className="mt-4 rounded-lg border border-danger/30 p-3 text-sm text-danger">
          {errorMessage(errorCode)}
        </p>
      )}
      {/* The suggestion is display-only. The server only edits `.env` when this button is clicked explicitly. */}
      {portSuggestion !== null && portCandidateId && screen !== "job" && (
        <article className="mt-4 rounded-lg border border-primary/40 bg-bg p-4">
          <h3 className="font-semibold">{t("hermes.wizard.port.title")}</h3>
          <p className="mt-1 text-sm text-text-muted">
            {t("hermes.wizard.port.body", { port: portSuggestion })}
          </p>
          <p className="mt-1 text-xs text-text-muted">{t("hermes.wizard.port.restartNote")}</p>
          <button
            type="button"
            name="accept-suggested-port"
            className={`${button} mt-3`}
            disabled={busy}
            onClick={() =>
              submitPrepare({
                action: "prepare",
                ...target,
                candidateId: portCandidateId,
                profiles: [],
                setPort: portSuggestion,
              })
            }
          >
            {busy
              ? t("hermes.wizard.port.applying")
              : t("hermes.wizard.port.apply", { port: portSuggestion })}
          </button>
        </article>
      )}
      {screen === "choice" && (
        <>
          <p className="my-4 text-text-muted">{c.intro}</p>
          <div className="grid gap-4 sm:grid-cols-2">
            {card(c.local, c.localHelp, Monitor, () => discover("local"), !cap?.local)}
            {card(c.remote, c.remoteHelp, Globe, () => navigate("remote"))}
          </div>
          {cap && !cap.local && (
            <p className="mt-3 text-sm text-text-muted">{hostReasonNote(cap.localReason)}</p>
          )}
          {!cap && !errorCode && (
            <p role="status" className="mt-3">
              {c.loading}
            </p>
          )}
        </>
      )}
      {screen === "remote" && (
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {card(c.ssh, c.sshHelp, Terminal, () => navigate("ssh"), !cap?.ssh)}
          {card(c.url, c.urlHelp, Server, () => navigate("url"))}
          {cap && !cap.ssh && (
            <p className="text-sm text-text-muted sm:col-span-2">{hostReasonNote(cap.sshReason)}</p>
          )}
        </div>
      )}
      {screen === "ssh" && (
        <div className="mt-4 space-y-4">
          <p className="text-sm text-text-muted">{c.sshHelp}</p>
          {registering || !cap?.sshHosts.length ? (
            <SshHostRegistration
              onRegistered={(host) => {
                // Re-fetch the registration list from the server — the server decides the verdict/label.
                void request<WizardCapabilities>().then((next) => {
                  setCap(next);
                  setHostId(host.id);
                  setRegistering(false);
                });
              }}
              onCancel={cap?.sshHosts.length ? () => setRegistering(false) : undefined}
            />
          ) : (
            <button
              className="text-sm font-semibold text-primary underline"
              onClick={() => setRegistering(true)}
            >
              {t("hermes.wizard.ssh.addHost")}
            </button>
          )}
          <label className="block text-sm font-semibold">
            {c.host}
            <select
              value={hostId}
              onChange={(e) => setHostId(e.target.value)}
              className={`${input} mt-2`}
            >
              <option value="">{c.chooseHost}</option>
              {cap?.sshHosts.map((host) => (
                <option key={host.id} value={host.id}>
                  {host.label}
                </option>
              ))}
            </select>
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              className={button}
              disabled={!hostId || !cap?.ssh}
              onClick={() => discover("ssh")}
            >
              {c.discover}
            </button>
            {/^h-[a-f0-9]{10}$/.test(hostId) && (
              <button
                className={secondary}
                disabled={busy}
                onClick={() =>
                  void request({ action: "ssh-remove", hostId })
                    .then(() => request<WizardCapabilities>())
                    .then((next) => {
                      setCap(next);
                      setHostId("");
                    })
                    .catch((err: { errorCode?: string }) =>
                      setErrorCode(err?.errorCode ?? "setup_failed"),
                    )
                }
              >
                {t("hermes.wizard.ssh.removeHost")}
              </button>
            )}
          </div>
        </div>
      )}
      {screen === "discover" && (
        <div className="mt-4 space-y-4">
          {mode === "local" && (
            <p className="text-sm text-text-muted">
              {c.localHelp} {cap?.hostLabel}
            </p>
          )}
          {busy ? (
            <p role="status">{c.discovering}</p>
          ) : (
            <>
              {discovered && !candidates.length && <p>{c.empty}</p>}
              {installOffered &&
                (canInstallHermes ? (
                  <article className="rounded-lg border border-primary/40 bg-bg p-4">
                    <h3 className="font-semibold">
                      {t(
                        mode === "ssh"
                          ? "hermes.wizard.install.titleSsh"
                          : "hermes.wizard.install.title",
                      )}
                    </h3>
                    <p className="mt-1 text-sm text-text-muted">
                      {t(
                        mode === "ssh"
                          ? "hermes.wizard.install.bodySsh"
                          : "hermes.wizard.install.body",
                      )}
                    </p>
                    <label className="mt-3 flex items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        name="install-consent"
                        className="mt-1 accent-primary"
                        checked={installConsent}
                        onChange={(event) => setInstallConsent(event.target.checked)}
                      />
                      <span>
                        {t(
                          mode === "ssh"
                            ? "hermes.wizard.install.consentSsh"
                            : "hermes.wizard.install.consent",
                        )}
                      </span>
                    </label>
                    <button
                      className={`${button} mt-3`}
                      disabled={busy || !installConsent}
                      onClick={() =>
                        void run(
                          (signal) =>
                            // The route doesn't know an action called install-hermes — installation is
                            // the installHermes flag on prepare. There's no candidate before installing, so candidateId is left empty.
                            request<{ job: WizardJob }>(
                              { action: "prepare", installHermes: true, profiles: [], ...target },
                              "",
                              signal,
                            ),
                          ({ job: next }) => {
                            setScreen("job");
                            acceptJob(next);
                          },
                        )
                      }
                    >
                      {t("hermes.wizard.install.start")}
                    </button>
                  </article>
                ) : (
                  <div className="rounded-lg border border-border bg-bg p-4 text-sm text-text-muted">
                    <p>{t("hermes.wizard.install.unavailable")}</p>
                    <CopyCommand
                      command={t("hermes.wizard.install.enableCommand")}
                      className="mt-3"
                    />
                    <p className="mt-2">{t("hermes.wizard.install.enableHint")}</p>
                  </div>
                ))}
              {digestLine}
              {candidates.map((candidate) => (
                <article key={candidate.id} className="rounded-lg border border-border bg-bg p-4">
                  <h3 className="font-semibold">{candidate.label}</h3>
                  <p className="mt-1 text-sm text-text-muted">
                    Hermes {candidate.version} · {c.service}: {candidate.service} · {candidate.port}
                    {candidate.pluginVersion
                      ? ` · ${c.pluginVersion} ${candidate.pluginVersion}`
                      : ""}
                  </p>
                  {candidate.profiles && (
                    <p className="mt-1 text-sm text-text-muted" data-candidate-profiles>
                      {candidate.profiles.length
                        ? `${c.profilesIncluded} ${candidate.profiles.length}: ${candidate.profiles.join(", ")}`
                        : c.noProfiles}
                    </p>
                  )}
                  {candidate.gatewayState && (
                    <p
                      className={`mt-1 text-sm ${candidate.gatewayState === "running" ? "text-text-muted" : "text-npc-dark"}`}
                      data-gateway-state={candidate.gatewayState}
                    >
                      {candidate.gatewayState === "running"
                        ? c.stateRunning
                        : candidate.gatewayState === "stopped"
                          ? c.stateStopped
                          : c.stateProfileGateways}
                    </p>
                  )}
                  {candidate.gatewayState === "profile_gateways" &&
                    candidate.profileGateways?.map((name) => (
                      <code key={name} className="mt-1 block text-xs">
                        {candidate.service.replace(/\.service$/, "")}-{name}
                      </code>
                    ))}
                  <button
                    className={`${button} mt-3`}
                    disabled={busy || candidate.gatewayState === "profile_gateways"}
                    onClick={() => inspect(candidate.id)}
                  >
                    {candidate.gatewayState === "stopped" ? c.startAndConnect : c.inspect}
                  </button>
                </article>
              ))}
              <button className={secondary} onClick={() => discover()}>
                {c.retry}
              </button>
            </>
          )}
        </div>
      )}
      {screen === "review" && inspection && (
        <div className="mt-4 space-y-4">
          <h3 className="font-semibold">{c.review}</h3>
          <p>{inspection.candidate.label}</p>
          <p className="text-sm">
            {c.service}: <strong>{inspection.candidate.service}</strong>
          </p>
          {inspection.candidate.pluginVersion && (
            <p className="text-xs text-text-muted">
              {c.pluginVersion}: {inspection.candidate.pluginVersion}
            </p>
          )}
          <p className="text-xs text-text-muted">
            {c.pluginRevision}: {PINNED_PLUGIN_COMMIT} ({PINNED_PLUGIN_VERSION})
          </p>
          <p role="status" className="rounded-lg bg-bg p-3 text-sm">
            {pluginLabel}
          </p>
          {blockingWarning && (
            <p role="alert" className="rounded-lg border border-danger/30 p-3 text-sm text-danger">
              {errorMessage(inspection.candidate.warning)}
            </p>
          )}
          <fieldset disabled={busy} className="space-y-3 rounded-lg border border-border p-4">
            <legend className="px-1 text-sm font-semibold">{c.selectProfiles}</legend>
            {(inspection.profiles ?? []).map((profile) => (
              <div key={profile.name} className="space-y-2">
                <label className="flex items-start gap-3 text-sm">
                  <input
                    type="checkbox"
                    name="profile"
                    className="mt-1 accent-primary"
                    disabled={!profile.hasToken && !profile.canProvision}
                    checked={selectedProfiles.includes(profile.name)}
                    onChange={(event) =>
                      setSelectedProfiles((current) =>
                        event.target.checked
                          ? [...current, profile.name]
                          : current.filter((name) => name !== profile.name),
                      )
                    }
                  />
                  <span>
                    <span className="font-medium">{profile.name}</span>
                    {!profile.hasToken && (
                      <span className="mt-1 block text-xs text-text-muted">
                        {profile.canProvision ? c.profileProvisionToken : c.profileNeedsToken}
                      </span>
                    )}
                  </span>
                </label>
                {/* This has a different role from importing: this checkbox issues a new key for a profile that has none. */}
                {profile.canProvision && (
                  <div className="ml-7">
                    <label className="flex items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        name="provision"
                        className="mt-1 accent-primary"
                        checked={provisionKeys.includes(profile.name)}
                        onChange={(event) =>
                          setProvisionKeys((current) =>
                            event.target.checked
                              ? [...current, profile.name]
                              : current.filter((name) => name !== profile.name),
                          )
                        }
                      />
                      <span>{t("hermes.wizard.profile.provisionLabel")}</span>
                    </label>
                    <p className="mt-1 text-xs text-text-muted">
                      {t("hermes.wizard.profile.provisionHint")}
                    </p>
                  </div>
                )}
              </div>
            ))}
            <p className="text-sm" aria-live="polite">
              {c.selectedProfiles}: {selectedProfiles.length}
            </p>
            {selectedProfiles.length === 0 && (
              <p className="text-sm text-text-muted">{c.noSelectedProfiles}</p>
            )}
          </fieldset>
          <fieldset disabled={busy} className="space-y-3 rounded-lg border border-border p-4">
            <legend className="px-1 text-sm font-semibold">
              {t("hermes.wizard.profile.newTitle")}
            </legend>
            <label className="block text-sm font-semibold">
              {t("hermes.wizard.profile.nameLabel")}
              <input
                className={`${input} mt-1`}
                type="text"
                name="new-profile-name"
                autoComplete="off"
                maxLength={64}
                value={newProfileName}
                onChange={(event) => setNewProfileName(event.target.value)}
              />
            </label>
            <p className="text-xs text-text-muted">{t("hermes.wizard.profile.nameHint")}</p>
            {!profileNameValid && (
              <p role="alert" className="text-xs text-danger">
                {t("hermes.wizard.error.profileNameInvalid")}
              </p>
            )}
            <label className="block text-sm font-semibold">
              {t("hermes.wizard.profile.descriptionLabel")}
              <input
                className={`${input} mt-1`}
                type="text"
                name="new-profile-description"
                autoComplete="off"
                maxLength={PROFILE_DESCRIPTION_MAX}
                value={newProfileDescription}
                onChange={(event) => setNewProfileDescription(event.target.value)}
              />
            </label>
            <p className="text-xs text-text-muted">{t("hermes.wizard.profile.descriptionHint")}</p>
          </fieldset>
          <h4 className="font-semibold">{c.changes}</h4>
          {inspection.changes.length || timezoneOffer ? (
            <ul className="list-inside list-disc text-sm">
              {inspection.changes
                .filter((change) => !(change === "setting_timezone" && timezoneOffer))
                .map((change, index) => (
                  <li key={index}>{changeText(change)}</li>
                ))}
              {timezoneOffer && (
                <li>
                  {t("hermes.wizard.review.timezone", { timezone: timezoneOffer })}
                  <label className="mt-1 flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-1 accent-primary"
                      disabled={busy}
                      checked={sendTimezone}
                      onChange={(event) => setSendTimezone(event.target.checked)}
                    />
                    <span>{c.reviewTimezoneToggle}</span>
                  </label>
                </li>
              )}
            </ul>
          ) : (
            <p className="text-sm">{c.noChanges}</p>
          )}
          <fieldset
            className="space-y-1 rounded-lg border border-border p-3"
            data-worker-propagation-choice=""
          >
            <legend className="px-1 text-sm font-semibold">
              {t("hermes.wizard.review.workerPropagation")}
            </legend>
            <p className="text-xs text-text-muted">
              {t("hermes.wizard.review.workerPropagationBody", {
                key: WORKER_PROPAGATION_CONFIG_KEY,
              })}
            </p>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1 accent-primary"
                name="worker-propagation"
                disabled={busy}
                checked={workerPropagation}
                onChange={(event) => setWorkerPropagation(event.target.checked)}
              />
              <span>{t("hermes.wizard.review.workerPropagationToggle")}</span>
            </label>
          </fieldset>
          <button
            className={button}
            disabled={
              busy ||
              !profileNameValid ||
              !!blockingWarning ||
              inspection.pluginStatus === "plugin_unauthorized"
            }
            onClick={() =>
              submitPrepare({
                action: "prepare",
                ...target,
                candidateId: inspection.candidate.id,
                profiles: selectedProfiles,
                ...(timezoneOffer && sendTimezone ? { timezone: timezoneOffer } : {}),
                workerPropagation,
                ...(trimmedProfileName
                  ? {
                      createProfile: {
                        name: trimmedProfileName,
                        ...(newProfileDescription.trim()
                          ? { description: newProfileDescription.trim() }
                          : {}),
                      },
                    }
                  : {}),
                ...(provisionKeys.length ? { provisionKeys } : {}),
              })
            }
          >
            {busy
              ? c.loading
              : inspection.changes.length || timezoneOffer || propagationChange
                ? c.prepare
                : c.verify}
          </button>
          <button
            className={`${secondary} ml-2`}
            disabled={busy}
            onClick={() => inspect(inspection.candidate.id)}
          >
            {c.retry}
          </button>
        </div>
      )}
      {screen === "job" && job && (
        <div className="mt-4 space-y-4">
          <h3 role="status" className="font-semibold">
            {job.status === "running"
              ? c.running
              : job.status === "cancelled"
                ? c.cancelled
                : job.status === "succeeded"
                  ? t("hermes.wizard.install.done")
                  : c.failed}
          </h3>
          <ol className="list-inside list-decimal space-y-2 text-sm" aria-live="polite">
            {job.steps.map((step, index) => (
              <li key={index}>
                {setupStep(c, step)}
                {skippedSteps.includes(step) && !ALWAYS_RERUN.has(step)
                  ? ` (${t("hermes.wizard.resume.skipped")})`
                  : ""}
              </li>
            ))}
          </ol>
          {/* An unknown milestone code comes back as undefined, so nothing is rendered. */}
          {setupProgress(locale, job.progress) && (
            <p className="text-sm text-text-muted" aria-live="polite">
              {setupProgress(locale, job.progress)}
            </p>
          )}
          {installingHermes && (
            <p className="text-sm text-text-muted" aria-live="polite">
              {t("hermes.wizard.progress.elapsed", { seconds: String(elapsed) })}
            </p>
          )}
          {job.status === "failed" && strings(job.completed).length > 0 && (
            <div className="rounded-lg border border-border bg-bg p-3">
              <h4 className="text-sm font-semibold">{t("hermes.wizard.resume.title")}</h4>
              <ul className="mt-1 list-inside list-disc text-sm text-text-muted">
                {strings(job.completed).map((step, index) => (
                  <li key={index}>{setupStep(c, step)}</li>
                ))}
              </ul>
            </div>
          )}
          {warningBanner}
          {digestLine}
          {job.error && (
            <p role="alert" className="text-sm text-danger">
              {errorMessage(job.error)}
            </p>
          )}
          {job.error === "system_packages_missing" &&
            (() => {
              const packages = parseSystemPackages((job.missingPackages ?? []).join(" "));
              const command = systemPackagesCommand(
                packageManagerFor(job.packageManager),
                packages,
              );
              return (
                <div className="space-y-2 text-sm" data-missing-packages={packages.join(" ")}>
                  <p>
                    {t("hermes.wizard.packages.missing")}{" "}
                    {packages.map((p) => t(`hermes.wizard.packages.${p}`)).join(", ")}
                  </p>
                  {command ? (
                    <CopyCommand command={command} />
                  ) : (
                    <p className="text-text-muted">{t("hermes.wizard.packages.unknownDistro")}</p>
                  )}
                  <p className="text-xs text-text-muted">{t("hermes.wizard.packages.retry")}</p>
                </div>
              );
            })()}
          {job.status === "running" ? (
            <>
              <p className="text-xs text-text-muted">{c.cancelHelp}</p>
              <button
                className={secondary}
                disabled={cancelling}
                onClick={() => {
                  setCancelling(true);
                  const epoch = generation.current;
                  const abort = new AbortController();
                  controller.current = abort;
                  void request<{ job: WizardJob }>(
                    { action: "cancel", jobId: job.id },
                    "",
                    abort.signal,
                  )
                    .then(({ job: next }) => {
                      if (epoch === generation.current && !abort.signal.aborted) acceptJob(next);
                    })
                    .catch((error) => {
                      if (epoch !== generation.current || abort.signal.aborted) return;
                      setCancelling(false);
                      setErrorCode(error.errorCode ?? "setup_failed");
                    });
                }}
              >
                {cancelling ? c.cancelling : c.cancel}
              </button>
            </>
          ) : (
            <div className="space-y-3">
              <div>
                {job.status === "failed" && lastPrepare && (
                  <button
                    className={`${button} mr-2`}
                    disabled={busy}
                    onClick={() => {
                      setSkippedSteps(strings(job.completed));
                      submitPrepare(lastPrepare, job.id);
                    }}
                  >
                    {t("hermes.wizard.resume.button")}
                  </button>
                )}
                <button className={button} onClick={() => discover()}>
                  {c.retry}
                </button>
              </div>
              {modelRecheck}
            </div>
          )}
        </div>
      )}
      {screen === "url" && (
        <form
          className="mt-4 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void run(
              (signal) =>
                request<{ gatewayId: string; pluginStatus: string }>(
                  {
                    action: "connect-url",
                    url: url.trim(),
                    token: token.trim(),
                    displayName: displayName.trim(),
                  },
                  "",
                  signal,
                ),
              (data) => {
                setToken("");
                setResult(data);
                setScreen("success");
                onSaved?.(data.gatewayId, data.pluginStatus);
              },
            );
          }}
        >
          {[
            [c.name, displayName, setDisplayName, "text"],
            [c.address, url, setUrl, "url"],
            [c.token, token, setToken, "password"],
          ].map(([label, value, setter, type]) => (
            <label key={String(label)} className="block text-sm font-semibold">
              {String(label)}
              <input
                className={`${input} mt-1`}
                type={String(type)}
                value={String(value)}
                required
                autoComplete={type === "password" ? "new-password" : "off"}
                onChange={(event) => (setter as (value: string) => void)(event.target.value)}
              />
              {type === "password" && (
                <p className="mt-1 text-xs text-text-muted">
                  {t("gateways.onboarding.step2OwnerKeyWarning")}
                </p>
              )}
            </label>
          ))}
          <button
            className={button}
            disabled={busy || !displayName.trim() || !url.trim() || !token.trim()}
          >
            {busy ? c.loading : c.connect}
          </button>
        </form>
      )}
      {screen === "success" && result && (
        <div className="mt-4 space-y-4">
          {warningBanner}
          {modelRecheck}
          {digestLine}
          {result.pluginStatus === "plugin_ready" ? (
            <>
              <p role="status">{c.connected}</p>
              <a
                className={`${button} inline-block`}
                href={`/profiles?gateway=${encodeURIComponent(result.gatewayId)}`}
                onClick={() => onConnected(result.gatewayId)}
              >
                {c.profiles}
              </a>
            </>
          ) : (
            <>
              <p role="status">
                {result.pluginStatus === "plugin_absent"
                  ? c.absent
                  : result.pluginStatus === "plugin_unauthorized"
                    ? c.unauthorized
                    : c.unknown}
              </p>
              <button className={button} disabled={!cap?.ssh} onClick={() => navigate("ssh")}>
                {c.installSsh}
              </button>
              <a
                className="ml-3 text-sm font-semibold text-primary underline"
                href="https://github.com/dandacompany/deskrpg-hermes-plugin#readme"
                target="_blank"
                rel="noreferrer"
              >
                {c.guide}
              </a>
              {cap && !cap.ssh && (
                <p className="text-sm text-text-muted">{hostReasonText(cap.sshReason)}</p>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
