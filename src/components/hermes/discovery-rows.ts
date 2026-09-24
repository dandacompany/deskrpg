import type { DiscoveryCandidate } from "@/lib/hermes/local-discovery";

export type DiscoveryRow = DiscoveryCandidate & {
  selectable: boolean;
  reason: "ok" | "no_token" | "not_served" | "already";
};

/**
 * Turns a candidate into a screen row. Only one reason is shown — listing
 * several leaves the user unsure what to fix first. Priority order is
 * already registered > no token > not served (least fixable first).
 */
export function toDiscoveryRows(candidates: DiscoveryCandidate[]): DiscoveryRow[] {
  return candidates.map((c) => {
    let reason: DiscoveryRow["reason"] = "ok";
    if (c.alreadyRegistered) reason = "already";
    else if (!c.hasToken) reason = "no_token";
    else if (!c.servedByGateway) reason = "not_served";
    return { ...c, selectable: reason === "ok", reason };
  });
}

export type ProbeStatus = "idle" | "ok" | "not_found" | "unknown";

const PROBE_STATUSES: ProbeStatus[] = ["idle", "ok", "not_found", "unknown"];

/**
 * Validates the `status` field of the `POST .../profiles/probe` response
 * against the screen's union type. If the server sends anything outside
 * these three values (e.g. a version mismatch), it collapses to
 * `"unknown"` — putting it straight into state without validation would
 * leave no i18n key and silently break the screen into a blank string.
 */
export function toProbeStatus(value: unknown): ProbeStatus {
  return typeof value === "string" && (PROBE_STATUSES as string[]).includes(value)
    ? (value as ProbeStatus)
    : "unknown";
}

export type RegistrationResult = { name: string; ok: boolean; errorCode?: string };
export type RegistrationFailure = { name: string; errorCode: string };

/**
 * Splits the bulk-registration response (`{ results }`) into the two
 * pieces the screen needs.
 *
 * A failed name stays in the selection — the user should be able to retry
 * right away without re-checking it. A failure without an errorCode (the
 * response shape didn't match what was expected) collapses to
 * "register_failed", so an unexplained failure doesn't silently vanish
 * from the screen.
 */
export function partitionRegistrationResults(results: RegistrationResult[]): {
  nextSelected: string[];
  failures: RegistrationFailure[];
} {
  const nextSelected: string[] = [];
  const failures: RegistrationFailure[] = [];
  for (const r of results) {
    if (r.ok) continue;
    nextSelected.push(r.name);
    failures.push({ name: r.name, errorCode: r.errorCode ?? "register_failed" });
  }
  return { nextSelected, failures };
}
