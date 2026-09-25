import { classifyGateFailure } from "@/lib/gate-failure";
import { PLUGIN_INSTALL_COMMAND as SHARED_PLUGIN_INSTALL_COMMAND } from "@/lib/hermes/plugin-install-command";
/**
 * Browser -> calls `/api/channels/:id/cron/**`. Hard gate: the browser never calls Hermes
 * directly — only these URLs are used. Auth follows the other channel APIs' session cookie
 * convention (same as `ChannelSettingsModal`'s `fetch`, no headers).
 *
 * All failures are thrown as `CronApiError` — carrying the server's `{code, message}` body
 * (`cronError`) as-is; special handling like 428/409 is decided by the screen (`describeCronError`).
 */

import type {
  AutomationBlueprint,
  CronDeliveryTarget,
  CronJob,
  CronRun,
  UpdateCronJobBody,
} from "@/lib/hermes/deskrpg-plugin-types";

/** The job carried in list/detail responses — same shape as the server's `EnrichedCronJob` (browser copy). */
export type CronJobView = CronJob & {
  npcId: string;
  npcName: string;
  origin: { channelId: string; createdByUserId: string | null } | null;
  editable: boolean;
};

export type CronListResponse = {
  jobs: CronJobView[];
  timezone: string | null;
  errors?: Array<{ npcId: string; code: string; message: string }>;
};

export type CronRunsResponse = { runs: CronRun[]; limit: number };

export type CreateCronJobInput = {
  npcId: string;
  name: string;
  prompt: string;
  schedule: string;
  deliver: string;
  model?: string;
  provider?: string;
};

export type InstantiateBlueprintInput = {
  npcId: string;
  blueprint: string;
  values: Record<string, string>;
  /** The job name the user sees; Hermes would name it after the English catalog title. */
  name?: string;
};

export class CronApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details: Record<string, unknown>) {
    super(message);
    this.name = "CronApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function isCronApiError(err: unknown): err is CronApiError {
  return err instanceof CronApiError;
}

async function readBody(res: Response): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await res.json();
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch (err) {
    throw new CronApiError(0, "unreachable", err instanceof Error ? err.message : String(err), {});
  }
  const body = await readBody(res);
  if (!res.ok) {
    const code = typeof body.code === "string" ? body.code : `http_${res.status}`;
    const message = typeof body.message === "string" ? body.message : res.statusText;
    throw new CronApiError(res.status, code, message, body);
  }
  return body as T;
}

function base(channelId: string): string {
  return `/api/channels/${encodeURIComponent(channelId)}/cron`;
}

function withNpc(path: string, npcId: string, extra?: Record<string, string>): string {
  const params = new URLSearchParams({ npcId, ...(extra ?? {}) });
  return `${path}?${params.toString()}`;
}

export const cronApi = {
  listJobs(channelId: string, npcId?: string | null): Promise<CronListResponse> {
    const path = `${base(channelId)}/jobs`;
    return request(npcId ? withNpc(path, npcId) : path);
  },

  getJob(channelId: string, jobId: string, npcId: string) {
    return request<{ job: CronJobView; timezone: string | null }>(
      withNpc(`${base(channelId)}/jobs/${encodeURIComponent(jobId)}`, npcId),
    );
  },

  listRuns(channelId: string, jobId: string, npcId: string, limit = 20) {
    return request<CronRunsResponse>(
      withNpc(`${base(channelId)}/jobs/${encodeURIComponent(jobId)}/runs`, npcId, {
        limit: String(limit),
      }),
    );
  },

  createJob(channelId: string, input: CreateCronJobInput) {
    return request<{ job: CronJobView }>(`${base(channelId)}/jobs`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  updateJob(
    channelId: string,
    jobId: string,
    npcId: string,
    updates: UpdateCronJobBody["updates"],
  ) {
    return request<{ job: CronJobView }>(`${base(channelId)}/jobs/${encodeURIComponent(jobId)}`, {
      method: "PUT",
      body: JSON.stringify({ npcId, updates }),
    });
  },

  pauseJob(channelId: string, jobId: string, npcId: string) {
    return request<{ job: CronJobView }>(
      `${base(channelId)}/jobs/${encodeURIComponent(jobId)}/pause`,
      { method: "POST", body: JSON.stringify({ npcId }) },
    );
  },

  resumeJob(channelId: string, jobId: string, npcId: string) {
    return request<{ job: CronJobView }>(
      `${base(channelId)}/jobs/${encodeURIComponent(jobId)}/resume`,
      { method: "POST", body: JSON.stringify({ npcId }) },
    );
  },

  /** R19 — returns 202 immediately. The result is observed via `cron:event` and run history. */
  runJob(channelId: string, jobId: string, npcId: string) {
    return request<{ accepted: boolean }>(
      `${base(channelId)}/jobs/${encodeURIComponent(jobId)}/run`,
      { method: "POST", body: JSON.stringify({ npcId }) },
    );
  },

  deleteJob(channelId: string, jobId: string, npcId: string) {
    return request<{ ok: boolean }>(
      withNpc(`${base(channelId)}/jobs/${encodeURIComponent(jobId)}`, npcId),
      { method: "DELETE" },
    );
  },

  listDeliveryTargets(channelId: string, npcId: string) {
    return request<{ targets: CronDeliveryTarget[] }>(
      withNpc(`${base(channelId)}/delivery-targets`, npcId),
    );
  },

  listBlueprints(channelId: string, npcId: string) {
    return request<{ blueprints: AutomationBlueprint[] }>(
      withNpc(`${base(channelId)}/blueprints`, npcId),
    );
  },

  instantiateBlueprint(channelId: string, input: InstantiateBlueprintInput) {
    return request<{ job: CronJobView }>(`${base(channelId)}/blueprints/instantiate`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
};

// ---------------------------------------------------------------------------
// Error -> screen copy (R31/R32)
// ---------------------------------------------------------------------------

/** Install command shown in the R31 notice. The minimum version prefers the server response's `minVersion`. */
/** The source of truth is `@/lib/hermes/plugin-install-command` — this keeps the existing import path. */
export const PLUGIN_INSTALL_COMMAND = SHARED_PLUGIN_INSTALL_COMMAND;
export const PLUGIN_MIN_VERSION = "0.6.0";

export type CronErrorNotice =
  | { kind: "upgrade"; minVersion: string; command: string }
  | { kind: "gateway" }
  | { kind: "other"; code: string; message: string; status: number };

/** Collapses an error into three kinds — upgrade notice / gateway connection notice / code+message as-is. */
export function classifyCronError(err: unknown): CronErrorNotice {
  if (isCronApiError(err)) {
    const minVersion =
      typeof err.details.minVersion === "string" ? err.details.minVersion : undefined;
    const blocker = classifyGateFailure({
      status: err.status,
      code: err.code,
      message: err.message,
      minVersion,
    });
    if (blocker.kind === "plugin_upgrade_required") {
      return { kind: "upgrade", minVersion: blocker.minVersion, command: blocker.command };
    }
    if (blocker.kind === "gateway_not_bound") return { kind: "gateway" };
    return { kind: "other", code: err.code, message: err.message, status: err.status };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { kind: "other", code: "unknown", message, status: 0 };
}
