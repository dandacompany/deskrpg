/**
 * The fake plugin server's 0.17.0 MCP routes — **test only**. Mimics paths, status codes,
 * error codes, and response fields DeskRPG depends on. No authorization (the plugin only
 * checks the profile key); no secret values are ever stored.
 */
import { createHash, randomUUID } from "node:crypto";

import type { McpCatalogEntry, McpServerView, McpTool } from "./plugin-client-types";

export type FakeMcpServer = {
  view: McpServerView;
  entry: Record<string, unknown>;
  tools: McpTool[] | null;
};

export type FakeMcpState = {
  servers: Map<string, FakeMcpServer>;
  catalog: McpCatalogEntry[];
  oauth: Map<string, { name: string; state: string; status: "pending" | "approved" | "error" }>;
  jobs: Map<
    string,
    { jobId: string; state: "succeeded" | "failed"; ok: boolean; tools?: McpTool[]; error?: string }
  >;
  reloads: number;
  lastActor: string | null;
  /** When set, the next connection test fails with this message. */
  failNextTest: string | null;
  seed(
    name: string,
    patch?: Partial<McpServerView> & { entry?: Record<string, unknown>; tools?: McpTool[] },
  ): void;
};

type Req = {
  method: string;
  pathname: string;
  params: URLSearchParams;
  json: unknown;
  headers: Record<string, string | undefined>;
};
type Reply = { status: number; body: unknown };

const err = (status: number, error: string, extra: Record<string, unknown> = {}): Reply => ({
  status,
  body: { error, ...extra },
});
const rev = (e: unknown) =>
  createHash("sha256").update(JSON.stringify(e)).digest("hex").slice(0, 16);

function viewOf(
  name: string,
  entry: Record<string, unknown>,
  patch: Partial<McpServerView> = {},
): McpServerView {
  const http = typeof entry.url === "string";
  return {
    name,
    kind: "custom",
    transport: http ? "http" : "stdio",
    endpointSummary: http
      ? String(entry.url)
          .replace(/^https?:\/\//, "")
          .split("?")[0]
      : String(entry.command ?? ""),
    enabled: entry.enabled !== false,
    trust: entry.trust === "untrusted" ? "untrusted" : "full",
    auth: entry.auth === "oauth" ? "oauth" : "none",
    secrets: [],
    oauthTokenPresent: false,
    tools: null,
    lastCheck: null,
    revision: rev(entry),
    ...patch,
  };
}

export function createFakeMcpState(): FakeMcpState {
  const state: FakeMcpState = {
    servers: new Map(),
    catalog: [],
    oauth: new Map(),
    jobs: new Map(),
    reloads: 0,
    lastActor: null,
    failNextTest: null,
    seed(name, patch = {}) {
      const { entry = { url: `https://${name}.example/mcp` }, tools = null, ...view } = patch;
      state.servers.set(name, { view: viewOf(name, entry, view), entry, tools });
    },
  };
  return state;
}

export function routeMcp(state: FakeMcpState, req: Req): Reply | null {
  const m = req.pathname.match(/^\/deskrpg\/mcp(\/.*)?$/);
  if (!m) return null;
  const rest = (m[1] ?? "").split("/").filter(Boolean).map(decodeURIComponent);
  const body = (req.json ?? {}) as Record<string, unknown>;
  if (req.method !== "GET") state.lastActor = req.headers["x-deskrpg-actor"] ?? null;
  const [a, b, c, d] = rest;

  if (a === "servers" && !b) {
    if (req.method === "GET")
      return { status: 200, body: { servers: [...state.servers.values()].map((s) => s.view) } };
    if (req.method === "POST") {
      const name = String(body.name ?? "");
      if (state.servers.has(name)) return err(409, "name_taken");
      if (body.transport === "stdio" && body.confirmName !== name)
        return err(400, "confirmation_required");
      if (
        String(body.command ?? "").includes("evil.example") ||
        (body.args as string[] | undefined)?.some((x) => x.includes("evil.example"))
      )
        return err(422, "mcp_security_rejected", { reasons: ["known malicious pattern"] });
      const entry =
        body.transport === "stdio"
          ? { command: body.command, args: body.args ?? [], trust: body.trust ?? "untrusted" }
          : { url: body.url, ...(body.auth === "oauth" ? { auth: "oauth" } : {}) };
      state.seed(name, { entry });
      return { status: 201, body: state.servers.get(name)!.view };
    }
  }
  if (a === "jobs" && b && req.method === "GET") {
    const job = state.jobs.get(b);
    return job ? { status: 200, body: job } : err(404, "job_unknown");
  }
  if (a === "oauth" && b) {
    const flow = state.oauth.get(b);
    if (!flow) return err(404, "oauth_session_not_found");
    if (c === "callback" && req.method === "POST") {
      if (body.state !== flow.state) return err(400, "oauth_callback_invalid");
      flow.status = "approved";
      const srv = state.servers.get(flow.name);
      if (srv) srv.view = { ...srv.view, oauthTokenPresent: true };
      return { status: 200, body: { ok: true } };
    }
    if (!c && req.method === "GET") return { status: 200, body: { status: flow.status } };
    if (!c && req.method === "DELETE") {
      state.oauth.delete(b);
      return { status: 200, body: { ok: true } };
    }
  }
  if (a === "catalog" && !b && req.method === "GET")
    return { status: 200, body: { entries: state.catalog } };
  if (a === "catalog" && b && c === "install" && req.method === "POST") {
    const entry = state.catalog.find((e) => e.name === b);
    if (!entry) return err(404, "catalog_entry_not_found");
    if (state.servers.has(b)) return err(409, "name_taken");
    const env = (body.env ?? {}) as Record<string, string>;
    const missing = entry.requiredEnv.filter((s) => s.required && !env[s.name]).map((s) => s.name);
    if (missing.length) return err(400, "missing_env", { detail: missing.join(", ") });
    state.seed(b, { kind: "catalog", entry: { url: `https://${b}.example/mcp` } });
    return { status: 201, body: state.servers.get(b)!.view };
  }
  if (a === "reload" && req.method === "POST") {
    state.reloads += 1;
    return {
      status: 200,
      body: { reloaded: true, servers: [...state.servers.keys()], agentsRefreshed: true },
    };
  }
  if (a === "export" && b && req.method === "GET") {
    const srv = state.servers.get(b);
    if (!srv) return err(404, "server_not_found");
    return {
      status: 200,
      body: {
        name: b,
        entry: srv.entry,
        secretKeys: srv.view.secrets.map((s) => s.key),
        oauth: srv.view.auth === "oauth",
      },
    };
  }

  if (a === "servers" && b) {
    const srv = state.servers.get(b);
    if (!srv) return err(404, "server_not_found");
    if (!c) {
      if (req.method === "GET")
        return {
          status: 200,
          body: {
            ...srv.view,
            url: srv.entry.url ?? null,
            command: srv.entry.command ?? null,
            args: srv.entry.args ?? [],
            cwd: null,
            envKeys: [],
            headerKeys: [],
            toolFilter: {},
          },
        };
      if (req.method === "DELETE") {
        state.servers.delete(b);
        return { status: 200, body: { ok: true } };
      }
      if (req.method === "PUT") {
        if (body.baseRevision !== srv.view.revision) return err(409, "revision_conflict");
        srv.entry = { ...srv.entry, ...(body.url ? { url: body.url } : {}) };
        srv.view = viewOf(b, srv.entry, { kind: srv.view.kind });
        return { status: 200, body: srv.view };
      }
    }
    if (c === "enabled" && req.method === "PUT") {
      srv.entry = { ...srv.entry, enabled: body.enabled };
      srv.view = { ...srv.view, enabled: body.enabled === true, revision: rev(srv.entry) };
      return { status: 200, body: srv.view };
    }
    if (c === "trust" && req.method === "PUT") {
      srv.view = { ...srv.view, trust: body.trust === "untrusted" ? "untrusted" : "full" };
      return { status: 200, body: srv.view };
    }
    if (c === "tools") {
      if (req.method === "GET")
        return srv.tools
          ? {
              status: 200,
              body: {
                tools: srv.tools,
                checkedAt: "2026-09-25T00:00:00Z",
                revision: srv.view.revision,
              },
            }
          : err(404, "tools_unknown");
      if (req.method === "PUT") {
        if (body.baseRevision !== srv.view.revision) return err(409, "revision_conflict");
        const include = body.include as string[] | undefined;
        srv.tools = (srv.tools ?? []).map((t) => ({
          ...t,
          on: include ? include.includes(t.name) : true,
        }));
        srv.view = {
          ...srv.view,
          tools: { total: srv.tools.length, enabled: srv.tools.filter((t) => t.on).length },
        };
        return { status: 200, body: srv.view };
      }
    }
    if (c === "secrets" && d) {
      const hasValue = req.method === "PUT";
      srv.view = {
        ...srv.view,
        secrets: [...srv.view.secrets.filter((s) => s.key !== d), { key: d, hasValue }],
      };
      return { status: 200, body: { key: d, hasValue } };
    }
    if (c === "test" && req.method === "POST") {
      const jobId = randomUUID();
      const fail = state.failNextTest;
      state.failNextTest = null;
      const job = fail
        ? { jobId, state: "succeeded" as const, ok: false, error: fail }
        : { jobId, state: "succeeded" as const, ok: true, tools: srv.tools ?? [] };
      state.jobs.set(jobId, job);
      srv.view = {
        ...srv.view,
        lastCheck: { at: "2026-09-25T00:00:00Z", ok: !fail, ...(fail ? { error: fail } : {}) },
      };
      return { status: 202, body: { jobId } };
    }
    if (c === "oauth" && req.method === "POST") {
      if (srv.view.auth !== "oauth") return err(400, "oauth_not_configured");
      const sessionId = randomUUID();
      state.oauth.set(sessionId, { name: b, state: `st-${sessionId}`, status: "pending" });
      return {
        status: 200,
        body: { sessionId, authUrl: `https://auth.example/authorize?state=st-${sessionId}` },
      };
    }
  }
  return err(404, "not_found");
}
