/** Display rules shared by the run-history rows and the detail tab's last run. */

const STATUS_KEYS: Record<string, string> = {
  ok: "cron.runs.status.ok",
  error: "cron.runs.status.error",
  running: "cron.runs.status.running",
};

/** The translation key for a run status — the history rows and "last run" read the same labels. */
export function runStatusKey(status: string | null | undefined): string {
  return (status && STATUS_KEYS[status]) || "cron.runs.status.unknown";
}

/**
 * Whether a run's summary is only Hermes' automatic session title: "<job name> · <%b %d %H:%M>"
 * (cron/scheduler.py), or "cron <job id>" when the job has no name. It repeats the job and the time
 * the row already shows — in English month names — so the row hides it. A title the model wrote is kept.
 */
export function isAutoRunTitle(summary: string): boolean {
  return /^.+ · [A-Z][a-z]{2} \d{2} \d{2}:\d{2}$/.test(summary) || /^cron \S+$/.test(summary);
}
