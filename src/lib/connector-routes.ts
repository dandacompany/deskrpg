/**
 * NPC MCP connector REST (`/api/channels/:id/npcs/:npcId/connectors/**`). One catch-all
 * route dispatches through this table, in the plugin's `routes.py` order (fixed segments
 * before a server name). Permission is decided here; the plugin only checks the profile key.
 * Two routes are DeskRPG's own: the OAuth callback (the pasted URL is parsed here so only
 * `code`/`state`/`iss` reach the plugin) and copy (export from this NPC, create on targets).
 */
import { NextResponse, type NextRequest } from "next/server";

import type { CopyResult } from "@/components/connectors/connector-types";
import {
  resolveConnectorContext,
  requireMcpCapability,
  type ConnectorContext,
} from "@/lib/connector-access";
import { cronError, pluginFailureResponse, resolveNpcProfileClient } from "@/lib/cron-access";
import type { McpAdminApi, McpServerInput, PluginResponse } from "@/lib/hermes/plugin-client-types";
import { getUserId } from "@/lib/internal-rpc";
import { parseOAuthPaste } from "@/lib/mcp-oauth-paste";
import { requireOwner, sharedChannelCount } from "@/lib/skill-access";

type Access = "member" | "owner";
type HandlerArgs = { args: string[]; body: Record<string, unknown> };
type Handler = (
  ctx: ConnectorContext,
  a: HandlerArgs,
) => Promise<PluginResponse<unknown> | Response>;
type Row = {
  method: string;
  pattern: string[];
  access: Access;
  handler: Handler;
  okStatus?: number;
};

const str = (v: unknown) => (typeof v === "string" ? v : "");
const strList = (v: unknown) =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
const FIXED = new Set(["servers", "jobs", "oauth", "catalog", "reload", "export", "copy"]);

async function oauthCallback(
  c: ConnectorContext,
  a: HandlerArgs,
): Promise<PluginResponse<unknown> | Response> {
  const parsed = parseOAuthPaste(str(a.body.redirectUrl));
  if (!parsed.ok) {
    return parsed.reason === "denied"
      ? cronError(400, "oauth_denied", parsed.error ?? "denied")
      : cronError(
          400,
          "oauth_callback_invalid",
          "Paste the full address from the browser after approving",
        );
  }
  const { code, state, iss } = parsed;
  return c.client.mcp.oauthCallback(
    a.args[0],
    iss ? { code, state, iss } : { code, state },
    c.userId,
  );
}

/** What copy carries from one exported server: the create body plus settings applied after create. */
type CopySource = {
  input: McpServerInput;
  toolFilter: { include?: string[]; exclude?: string[] } | null;
  disabled: boolean;
};

async function copy(c: ConnectorContext, a: HandlerArgs): Promise<Response> {
  const names = [...new Set(strList(a.body.names))];
  const targets = [...new Set(strList(a.body.targetNpcIds))].filter((id) => id !== c.npcId);
  const exported = new Map<string, CopySource | { code: string }>();
  for (const name of names) {
    const res = await c.client.mcp.exportServer(name);
    exported.set(name, res.ok ? toCopySource(name, res.data.entry) : { code: res.failure.code });
  }
  const results: CopyResult[] = [];
  for (const npcId of targets) {
    const target = await resolveNpcProfileClient(c.channel, npcId);
    for (const name of names) {
      if (!target.ok) {
        results.push({ npcId, name, ok: false, code: "npc_not_found" });
        continue;
      }
      const src = exported.get(name)!;
      if ("code" in src) {
        results.push({ npcId, name, ok: false, code: src.code });
        continue;
      }
      const code = await copyOne(target.value.client.mcp, name, src, c.userId);
      results.push(code ? { npcId, name, ok: false, code } : { npcId, name, ok: true });
    }
  }
  return NextResponse.json({ results });
}

/** Creates one server on the target, then its tool filter and disabled state. Returns the failure code, if any. */
async function copyOne(
  mcp: McpAdminApi,
  name: string,
  src: CopySource,
  actor: string,
): Promise<string | null> {
  const created = await mcp.create(src.input, actor);
  if (!created.ok) return created.failure.code;
  if (src.toolFilter) {
    const res = await mcp.setTools(
      name,
      { ...src.toolFilter, baseRevision: created.data.revision },
      actor,
    );
    if (!res.ok) return res.failure.code;
  }
  if (src.disabled) {
    const res = await mcp.setEnabled(name, false, actor);
    if (!res.ok) return res.failure.code;
  }
  return null;
}

/** A header value that is only an env reference, optionally after a scheme word (`Bearer ${KEY}`). */
const HEADER_REF = /^(?:[A-Za-z][\w-]* )?\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

/**
 * Converts an exported Hermes entry to what copy sends. Settings travel; secret values and
 * OAuth tokens do not: env goes as keys only (the plugin stores `${KEY}` references), headers go
 * only when their value is a `${KEY}` reference, and a bearer header is rebuilt by the plugin from
 * the server name. The target must be re-authenticated.
 */
function toCopySource(name: string, e: Record<string, unknown>): CopySource {
  const http = typeof e.url === "string";
  const rawHeaders = (e.headers ?? {}) as Record<string, unknown>;
  const headers = Object.fromEntries(
    Object.entries(rawHeaders).filter(
      (kv): kv is [string, string] => typeof kv[1] === "string" && HEADER_REF.test(kv[1]),
    ),
  );
  const bearer =
    typeof rawHeaders.Authorization === "string" &&
    rawHeaders.Authorization.startsWith("Bearer ${");
  const env = e.env && typeof e.env === "object" ? (e.env as Record<string, string>) : null;
  const tools = (e.tools ?? {}) as Record<string, unknown>;
  const filter = {
    ...(Array.isArray(tools.include) ? { include: strList(tools.include) } : {}),
    ...(Array.isArray(tools.exclude) ? { exclude: strList(tools.exclude) } : {}),
  };
  return {
    input: {
      name,
      transport: http ? "http" : "stdio",
      ...(http
        ? { url: String(e.url), ...(Object.keys(headers).length ? { headers } : {}) }
        : {
            command: str(e.command),
            args: strList(e.args),
            ...(e.cwd ? { cwd: str(e.cwd) } : {}),
          }),
      ...(env ? { env } : {}),
      auth: e.auth === "oauth" ? "oauth" : bearer ? "bearer" : env ? "env" : "none",
      ...(e.trust === "full" || e.trust === "untrusted" ? { trust: e.trust } : {}),
      // Already confirmed on the source NPC.
      confirmName: name,
    },
    toolFilter: Object.keys(filter).length ? filter : null,
    disabled: e.enabled === false,
  };
}

// Table order is match order.
const ROWS: Row[] = [
  { method: "GET", pattern: ["servers"], access: "member", handler: (c) => c.client.mcp.list() },
  {
    method: "POST",
    pattern: ["servers"],
    access: "owner",
    okStatus: 201,
    handler: (c, a) => c.client.mcp.create(a.body as McpServerInput, c.userId),
  },
  {
    method: "GET",
    pattern: ["jobs", "*"],
    access: "owner",
    handler: (c, a) => c.client.mcp.job(a.args[0]),
  },
  { method: "POST", pattern: ["oauth", "*", "callback"], access: "owner", handler: oauthCallback },
  {
    method: "GET",
    pattern: ["oauth", "*"],
    access: "owner",
    handler: (c, a) => c.client.mcp.oauthPoll(a.args[0]),
  },
  {
    method: "DELETE",
    pattern: ["oauth", "*"],
    access: "owner",
    handler: (c, a) => c.client.mcp.oauthCancel(a.args[0], c.userId),
  },
  { method: "GET", pattern: ["catalog"], access: "member", handler: (c) => c.client.mcp.catalog() },
  {
    method: "POST",
    pattern: ["catalog", "*", "install"],
    access: "owner",
    okStatus: 201,
    handler: (c, a) =>
      c.client.mcp.catalogInstall(
        a.args[0],
        { env: (a.body.env ?? {}) as Record<string, string>, enable: a.body.enable !== false },
        c.userId,
      ),
  },
  {
    method: "POST",
    pattern: ["reload"],
    access: "owner",
    handler: (c) => c.client.mcp.reload(c.userId),
  },
  { method: "POST", pattern: ["copy"], access: "owner", handler: copy },
  {
    method: "GET",
    pattern: ["servers", "*"],
    access: "owner",
    handler: (c, a) => c.client.mcp.detail(a.args[0]),
  },
  {
    method: "PUT",
    pattern: ["servers", "*"],
    access: "owner",
    handler: (c, a) => c.client.mcp.update(a.args[0], a.body as McpServerInput, c.userId),
  },
  {
    method: "DELETE",
    pattern: ["servers", "*"],
    access: "owner",
    handler: (c, a) => c.client.mcp.remove(a.args[0], c.userId),
  },
  {
    method: "PUT",
    pattern: ["servers", "*", "enabled"],
    access: "owner",
    handler: (c, a) => c.client.mcp.setEnabled(a.args[0], a.body.enabled === true, c.userId),
  },
  {
    method: "PUT",
    pattern: ["servers", "*", "trust"],
    access: "owner",
    handler: (c, a) =>
      c.client.mcp.setTrust(
        a.args[0],
        a.body.trust === "untrusted" ? "untrusted" : "full",
        c.userId,
      ),
  },
  {
    method: "GET",
    pattern: ["servers", "*", "tools"],
    access: "member",
    handler: (c, a) => c.client.mcp.tools(a.args[0]),
  },
  {
    method: "PUT",
    pattern: ["servers", "*", "tools"],
    access: "owner",
    handler: (c, a) =>
      c.client.mcp.setTools(
        a.args[0],
        {
          ...(Array.isArray(a.body.include) ? { include: strList(a.body.include) } : {}),
          ...(Array.isArray(a.body.exclude) ? { exclude: strList(a.body.exclude) } : {}),
          baseRevision: str(a.body.baseRevision),
        },
        c.userId,
      ),
  },
  {
    method: "PUT",
    pattern: ["servers", "*", "secrets", "*"],
    access: "owner",
    handler: (c, a) => c.client.mcp.putSecret(a.args[0], a.args[1], str(a.body.value), c.userId),
  },
  {
    method: "DELETE",
    pattern: ["servers", "*", "secrets", "*"],
    access: "owner",
    handler: (c, a) => c.client.mcp.deleteSecret(a.args[0], a.args[1], c.userId),
  },
  {
    method: "POST",
    pattern: ["servers", "*", "test"],
    access: "owner",
    okStatus: 202,
    handler: (c, a) => c.client.mcp.test(a.args[0], c.userId),
  },
  {
    method: "POST",
    pattern: ["servers", "*", "oauth"],
    access: "owner",
    handler: (c, a) => c.client.mcp.oauthStart(a.args[0], c.userId),
  },
];

function match(method: string, path: string[]): { row: Row; args: string[] } | null {
  for (const row of ROWS) {
    if (row.method !== method || row.pattern.length !== path.length) continue;
    const args: string[] = [];
    const ok = row.pattern.every((p, i) => {
      if (p !== "*") return p === path[i];
      args.push(path[i]);
      return true;
    });
    if (ok && FIXED.has(path[0])) return { row, args };
  }
  return null;
}

async function readBody(req: NextRequest): Promise<Record<string, unknown>> {
  if (req.method === "GET") return {};
  try {
    const parsed: unknown = await req.json();
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function relay(res: PluginResponse<unknown> | Response, okStatus: number): Response {
  if (res instanceof Response) return res;
  if (!res.ok) return pluginFailureResponse(res);
  return NextResponse.json(res.data, { status: okStatus });
}

export async function handleConnectorRoute(
  req: NextRequest,
  params: { id: string; npcId: string; path?: string[] },
): Promise<Response> {
  const resolved = await resolveConnectorContext({
    userId: getUserId(req),
    channelId: params.id,
    npcId: params.npcId,
  });
  if (!resolved.ok) return resolved.response;
  const { ctx } = resolved;
  const gate = requireMcpCapability(ctx);
  if (gate) return gate;
  const path = params.path ?? [];

  if (req.method === "GET" && path.length === 0) {
    const res = await ctx.client.mcp.list();
    if (!res.ok) return pluginFailureResponse(res);
    return NextResponse.json({
      servers: res.data.servers,
      canManage: ctx.isGatewayOwner,
      capabilityReady: true,
      sharedChannelCount: await sharedChannelCount(ctx),
    });
  }

  const found = match(req.method, path);
  if (!found) return cronError(404, "not_found", "Unknown connector route");
  const owner = found.row.access === "owner" ? requireOwner(ctx) : null;
  if (owner) return owner;
  const out = await found.row.handler(ctx, { args: found.args, body: await readBody(req) });
  return relay(out, found.row.okStatus ?? 200);
}
