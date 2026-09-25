/**
 * Browser-side calls to the NPC connector REST (`/api/channels/:id/npcs/:npcId/connectors/**`).
 * Failures surface as `ConnectorsApiError` carrying the server's `{code, message, …}`;
 * translation is the UI's job.
 */
import type {
  McpCatalogEntry,
  McpJob,
  McpOAuthPoll,
  McpOAuthStart,
  McpReload,
  McpServerDetail,
  McpServerInput,
  McpServerView,
  McpTool,
} from "@/lib/hermes/plugin-client-types";

import type { ConnectorListView, CopyResult } from "./connector-types";

export class ConnectorsApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** Every other body field — e.g. `reasons` for a security rejection, `minVersion` for 428. */
  readonly extra: Record<string, unknown>;
  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = "ConnectorsApiError";
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

async function fail(res: Response): Promise<ConnectorsApiError> {
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await res.json();
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    /* no body */
  }
  const { code, message, ...extra } = body;
  return new ConnectorsApiError(
    res.status,
    typeof code === "string" ? code : "http_error",
    typeof message === "string" ? message : "",
    extra,
  );
}

export function createConnectorsApi(
  channelId: string,
  npcId: string,
  fetchImpl: typeof fetch = fetch,
) {
  const root = `/api/channels/${encodeURIComponent(channelId)}/npcs/${encodeURIComponent(npcId)}/connectors`;
  const seg = (s: string) => encodeURIComponent(s);
  async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetchImpl(`${root}/${path}`, {
      method,
      ...(body !== undefined
        ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
        : {}),
    });
    if (!res.ok) throw await fail(res);
    return (await res.json()) as T;
  }
  const srv = (name: string, suffix = "") => `servers/${seg(name)}${suffix}`;
  return {
    list: () => req<ConnectorListView>("GET", ""),
    detail: (name: string) => req<McpServerDetail>("GET", srv(name)),
    create: (body: McpServerInput) => req<McpServerView>("POST", "servers", body),
    update: (name: string, body: McpServerInput) => req<McpServerView>("PUT", srv(name), body),
    remove: (name: string) => req<{ ok: true }>("DELETE", srv(name)),
    setEnabled: (name: string, enabled: boolean) =>
      req<McpServerView>("PUT", srv(name, "/enabled"), { enabled }),
    setTrust: (name: string, trust: "full" | "untrusted") =>
      req<McpServerView>("PUT", srv(name, "/trust"), { trust }),
    setTools: (
      name: string,
      body: { include?: string[]; exclude?: string[]; baseRevision: string },
    ) => req<McpServerView>("PUT", srv(name, "/tools"), body),
    putSecret: (name: string, key: string, value: string) =>
      req<{ key: string; hasValue: boolean }>("PUT", srv(name, `/secrets/${seg(key)}`), { value }),
    deleteSecret: (name: string, key: string) =>
      req<{ key: string; hasValue: boolean }>("DELETE", srv(name, `/secrets/${seg(key)}`)),
    test: (name: string) => req<{ jobId: string }>("POST", srv(name, "/test"), {}),
    job: (jobId: string) => req<McpJob>("GET", `jobs/${seg(jobId)}`),
    tools: (name: string) =>
      req<{ tools: McpTool[]; checkedAt: string; revision: string }>("GET", srv(name, "/tools")),
    oauthStart: (name: string, restart = false) =>
      req<McpOAuthStart>("POST", srv(name, "/oauth"), restart ? { restart: true } : {}),
    /** Sends the whole pasted address — the server extracts `code`/`state` itself. */
    oauthCallback: (sessionId: string, redirectUrl: string) =>
      req<{ ok: true }>("POST", `oauth/${seg(sessionId)}/callback`, { redirectUrl }),
    oauthPoll: (sessionId: string) => req<McpOAuthPoll>("GET", `oauth/${seg(sessionId)}`),
    oauthCancel: (sessionId: string) => req<{ ok: boolean }>("DELETE", `oauth/${seg(sessionId)}`),
    catalog: () => req<{ entries: McpCatalogEntry[] }>("GET", "catalog"),
    catalogInstall: (entry: string, env: Record<string, string>) =>
      req<McpServerView>("POST", `catalog/${seg(entry)}/install`, { env, enable: true }),
    reload: () => req<McpReload>("POST", "reload", {}),
    copy: (targetNpcIds: string[], names: string[]) =>
      req<{ results: CopyResult[] }>("POST", "copy", { targetNpcIds, names }),
  };
}

export type ConnectorsApi = ReturnType<typeof createConnectorsApi>;
