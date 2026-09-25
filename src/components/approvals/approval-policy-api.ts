/**
 * Browser-side calls to an NPC's unattended run policy
 * (`/api/channels/:id/npcs/:npcId/approval-policy/**`). Failures surface as
 * `ApprovalPolicyApiError` carrying the server's `{code, message, …}`; translation is the UI's job.
 */
import type { ApprovalMode, ApprovalPolicy } from "@/lib/hermes/plugin-client-types";

/** The policy as the route returns it — the connector list's permission fields added. */
export type ApprovalPolicyView = ApprovalPolicy & {
  canManage: boolean;
  capabilityReady: boolean;
  /** Other channels that hired the same profile — the policy is per profile. */
  sharedChannelCount: number;
};

export class ApprovalPolicyApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApprovalPolicyApiError";
    this.status = status;
    this.code = code;
  }
}

export function createApprovalPolicyApi(
  channelId: string,
  npcId: string,
  fetchImpl: typeof fetch = fetch,
) {
  const root = `/api/channels/${encodeURIComponent(channelId)}/npcs/${encodeURIComponent(npcId)}/approval-policy`;
  async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetchImpl(path ? `${root}/${path}` : root, {
      method,
      ...(body !== undefined
        ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
        : {}),
    });
    if (!res.ok) {
      let data: Record<string, unknown> = {};
      try {
        const parsed: unknown = await res.json();
        if (parsed && typeof parsed === "object") data = parsed as Record<string, unknown>;
      } catch {
        /* no body */
      }
      throw new ApprovalPolicyApiError(
        res.status,
        typeof data.code === "string" ? data.code : "http_error",
        typeof data.message === "string" ? data.message : "",
      );
    }
    return (await res.json()) as T;
  }
  return {
    get: () => req<ApprovalPolicyView>("GET", ""),
    setModes: (body: { cronMode?: ApprovalMode; singleQueryMode?: ApprovalMode }) =>
      req<ApprovalPolicy>("PUT", "", body),
    addAllowlist: (entry: string) => req<ApprovalPolicy>("POST", "allowlist", { entry }),
    removeAllowlist: (entry: string) => req<ApprovalPolicy>("DELETE", "allowlist", { entry }),
  };
}

export type ApprovalPolicyClientApi = ReturnType<typeof createApprovalPolicyApi>;

/** The plugin's allowlist format rule (1–200 characters, no line breaks), checked before sending. */
export function isValidAllowlistEntry(entry: string): boolean {
  return entry.length >= 1 && entry.length <= 200 && !/[\r\n]/.test(entry);
}
