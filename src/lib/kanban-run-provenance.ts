/**
 * How a run made its result, read from the free-form `metadata` a worker leaves on the run when it
 * completes or asks for review (`kanban_complete(metadata=…)`).
 *
 * Hermes suggests a few keys but enforces none, so only the well-known ones are read and every
 * other key is only counted. Values come from the model: anything that is not the expected shape
 * is dropped rather than guessed at. Paths are shown relative to the card's working folder; a path
 * outside it is shown by file name only, so the server's directory layout does not spread further
 * than the card already shows it.
 *
 * Pure and dependency-free — safe for the client bundle.
 */

/** Keys read here; everything else counts toward `otherKeys`. */
const KNOWN_KEYS = new Set([
  "changed_files",
  "artifacts",
  "verification",
  "limitations",
  "worker_session_id",
  // Read by `kanban-run-history.ts` (failure cause), not shown as "other".
  "terminal_provider",
]);

const MAX_ITEMS = 20;
const MAX_TEXT = 300;

export type RunCheck = { key: string; value: string };

export type RunProvenance = {
  changedFiles: string[];
  artifacts: string[];
  /** `verification.*` flattened to one level of readable pairs (booleans, numbers, short text). */
  checks: RunCheck[];
  limitations: string[];
  /** The worker's Hermes session — where its sources can be looked up. */
  workerSessionId: string | null;
  /** Keys this reader does not show. */
  otherKeys: number;
};

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > MAX_TEXT ? `${trimmed.slice(0, MAX_TEXT - 1)}…` : trimmed;
}

function texts(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return list
    .map(text)
    .filter((v): v is string => v !== null)
    .slice(0, MAX_ITEMS);
}

/** `path` relative to `workspace` when inside it; otherwise just the file name. */
export function workspaceRelative(path: string, workspace: string | null | undefined): string {
  const root = (workspace ?? "").replace(/\/+$/, "");
  if (root && path.startsWith(`${root}/`)) return path.slice(root.length + 1);
  if (!path.startsWith("/") && !path.startsWith("~")) {
    return path.split("/").includes("..") ? (path.split("/").pop() ?? path) : path;
  }
  return path.split("/").filter(Boolean).pop() ?? path;
}

function paths(value: unknown, workspace: string | null | undefined): string[] {
  const list = Array.isArray(value) ? value : [];
  const out: string[] = [];
  for (const item of list) {
    const raw =
      text(item) ??
      (item && typeof item === "object" ? text((item as { path?: unknown }).path) : null);
    if (!raw) continue;
    const shown = workspaceRelative(raw, workspace);
    if (!out.includes(shown)) out.push(shown);
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

function checks(value: unknown): RunCheck[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const out: RunCheck[] = [];
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    let shown: string | null = null;
    if (typeof raw === "boolean") shown = raw ? "✓" : "✗";
    else if (typeof raw === "number" && Number.isFinite(raw)) shown = String(raw);
    else shown = text(raw);
    if (shown !== null) out.push({ key, value: shown });
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

export function runProvenance(
  metadata: Record<string, unknown> | null | undefined,
  workspace?: string | null,
): RunProvenance {
  const meta = metadata && typeof metadata === "object" ? metadata : {};
  return {
    changedFiles: paths(meta.changed_files, workspace),
    artifacts: paths(meta.artifacts, workspace),
    checks: checks(meta.verification),
    limitations: texts(meta.limitations),
    workerSessionId: text(meta.worker_session_id),
    otherKeys: Object.keys(meta).filter((key) => !KNOWN_KEYS.has(key)).length,
  };
}

/** True when there is something to show besides the session id. */
export function hasRunProvenance(p: RunProvenance): boolean {
  return (
    p.changedFiles.length > 0 ||
    p.artifacts.length > 0 ||
    p.checks.length > 0 ||
    p.limitations.length > 0 ||
    p.otherKeys > 0
  );
}
