/**
 * NPC skill management REST (`/api/channels/:id/npcs/:npcId/skills/**`). A single catch-all
 * route dispatches through this table — in the same order as the plugin's `routes.py`, with
 * the fixed segments (`enabled`·`archive`·`hub`·`curator`·`learning`) matched before a skill
 * name. Permission is decided entirely here (the server); the plugin only checks the profile key.
 */
import { NextResponse, type NextRequest } from "next/server";

import { cronError, pluginFailureResponse } from "@/lib/cron-access";
import type { PluginResponse } from "@/lib/hermes/plugin-client-types";
import { getUserId } from "@/lib/internal-rpc";
import {
  requireCapability,
  requireOwner,
  resolveSkillContext,
  sharedChannelCount,
  type SkillContext,
} from "@/lib/skill-access";

type Access = "member" | "owner";
type HandlerArgs = { args: string[]; body: Record<string, unknown>; sp: URLSearchParams };
type Handler = (ctx: SkillContext, a: HandlerArgs) => Promise<PluginResponse<unknown> | Response>;
type Row = {
  method: string;
  /** `*` matches one path-segment argument. */
  pattern: string[];
  access: Access;
  handler: Handler;
  /** Success status code — 202 for a call that starts a job, 201 for creation. Defaults to 200. */
  okStatus?: number;
};

const str = (v: unknown) => (typeof v === "string" ? v : "");
const strList = (v: unknown) =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
const FIXED = new Set(["enabled", "archive", "hub", "curator", "learning"]);

// Table order is match order.
const ROWS: Row[] = [
  {
    method: "PUT",
    pattern: ["enabled"],
    access: "owner",
    handler: (c, a) =>
      c.client.skills.setEnabledBulk(
        { enable: strList(a.body.enable), disable: strList(a.body.disable) },
        c.userId,
      ),
  },
  {
    method: "GET",
    pattern: ["archive"],
    access: "member",
    handler: (c) => c.client.skills.listArchived(),
  },
  {
    method: "POST",
    pattern: ["archive", "*", "restore"],
    access: "owner",
    handler: (c, a) => c.client.skills.restore(a.args[0], c.userId),
  },
  {
    method: "DELETE",
    pattern: ["archive", "*"],
    access: "owner",
    handler: (c, a) => c.client.skills.purge(a.args[0], c.userId),
  },
  {
    method: "GET",
    pattern: ["hub", "search"],
    access: "owner",
    handler: (c, a) =>
      c.client.skills.hubSearch(a.sp.get("q") ?? "", a.sp.get("source") ?? undefined),
  },
  {
    method: "GET",
    pattern: ["hub", "preview"],
    access: "owner",
    handler: (c, a) => c.client.skills.hubPreview(a.sp.get("identifier") ?? ""),
  },
  {
    method: "POST",
    pattern: ["hub", "installs"],
    access: "owner",
    okStatus: 202,
    handler: (c, a) =>
      c.client.skills.hubInstall(
        { identifier: str(a.body.identifier), force: a.body.force === true },
        c.userId,
      ),
  },
  {
    method: "GET",
    pattern: ["hub", "installs", "*"],
    access: "owner",
    handler: (c, a) => c.client.skills.job("hub", a.args[0]),
  },
  {
    method: "POST",
    pattern: ["hub", "uninstall"],
    access: "owner",
    okStatus: 202,
    handler: (c, a) => c.client.skills.hubUninstall(str(a.body.name), c.userId),
  },
  {
    method: "POST",
    pattern: ["hub", "update"],
    access: "owner",
    okStatus: 202,
    handler: (c, a) => c.client.skills.hubUpdate(str(a.body.name) || null, c.userId),
  },
  {
    method: "GET",
    pattern: ["curator"],
    access: "member",
    handler: (c) => c.client.skills.curator(),
  },
  {
    method: "PUT",
    pattern: ["curator", "paused"],
    access: "owner",
    handler: (c, a) => c.client.skills.setCuratorPaused(a.body.paused === true, c.userId),
  },
  {
    method: "POST",
    pattern: ["curator", "runs"],
    access: "owner",
    okStatus: 202,
    handler: (c) => c.client.skills.runCurator(c.userId),
  },
  {
    method: "GET",
    pattern: ["curator", "runs", "*"],
    access: "owner",
    handler: (c, a) => c.client.skills.job("curator", a.args[0]),
  },
  {
    // Memory nodes go to the owner only — for a member, includeMemory=0 tells the plugin to strip memory before sending.
    method: "GET",
    pattern: ["learning", "graph"],
    access: "member",
    handler: (c) => c.client.skills.graph(c.isGatewayOwner),
  },
  {
    method: "GET",
    pattern: ["learning", "node"],
    access: "member",
    handler: async (c, a) => {
      const id = a.sp.get("id") ?? "";
      if (id.startsWith("memory:")) {
        const denied = requireOwner(c);
        if (denied) return denied;
      }
      return c.client.skills.node(id);
    },
  },
  {
    method: "PUT",
    pattern: ["learning", "node"],
    access: "owner",
    handler: (c, a) =>
      c.client.skills.putNode(
        { id: str(a.body.id), content: str(a.body.content), baseHash: str(a.body.baseHash) },
        c.userId,
      ),
  },
  {
    method: "DELETE",
    pattern: ["learning", "node"],
    access: "owner",
    handler: (c, a) =>
      c.client.skills.deleteNode({ id: str(a.body.id), baseHash: str(a.body.baseHash) }, c.userId),
  },
  {
    method: "POST",
    pattern: [],
    access: "owner",
    okStatus: 201,
    handler: (c, a) =>
      c.client.skills.create(
        {
          name: str(a.body.name),
          category: str(a.body.category) || undefined,
          content: str(a.body.content),
        },
        c.userId,
      ),
  },
  {
    method: "GET",
    pattern: ["*"],
    access: "member",
    handler: (c, a) => c.client.skills.detail(a.args[0]),
  },
  {
    method: "GET",
    pattern: ["*", "file"],
    access: "member",
    handler: (c, a) => c.client.skills.readFile(a.args[0], a.sp.get("path") ?? ""),
  },
  {
    method: "PUT",
    pattern: ["*", "file"],
    access: "owner",
    handler: (c, a) =>
      c.client.skills.writeFile(
        a.args[0],
        {
          path: str(a.body.path),
          content: str(a.body.content),
          baseHash: typeof a.body.baseHash === "string" ? a.body.baseHash : null,
        },
        c.userId,
      ),
  },
  {
    method: "PUT",
    pattern: ["*", "enabled"],
    access: "owner",
    handler: (c, a) => c.client.skills.setEnabled(a.args[0], a.body.enabled === true, c.userId),
  },
  {
    method: "PUT",
    pattern: ["*", "pinned"],
    access: "owner",
    handler: (c, a) => c.client.skills.setPinned(a.args[0], a.body.pinned === true, c.userId),
  },
  {
    method: "POST",
    pattern: ["*", "archive"],
    access: "owner",
    handler: (c, a) => c.client.skills.archive(a.args[0], c.userId),
  },
];

function match(method: string, path: string[]): { row: Row; args: string[] } | null {
  for (const row of ROWS) {
    if (row.method !== method || row.pattern.length !== path.length) continue;
    const args: string[] = [];
    const ok = row.pattern.every((p, i) => {
      if (p !== "*") return p === path[i];
      // A fixed segment name is never accepted by the first-position wildcard — the fixed rows in the table come first.
      if (i === 0 && FIXED.has(path[i])) return false;
      args.push(path[i]);
      return true;
    });
    if (ok) return { row, args };
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

export async function handleSkillRoute(
  req: NextRequest,
  params: { id: string; npcId: string; path?: string[] },
): Promise<Response> {
  const resolved = await resolveSkillContext({
    userId: getUserId(req),
    channelId: params.id,
    npcId: params.npcId,
  });
  if (!resolved.ok) return resolved.response;
  const { ctx } = resolved;
  const path = params.path ?? [];

  // The list responds with legacy fields even without the capability — so the screen can show "upgrade required" right there.
  if (req.method === "GET" && path.length === 0) {
    const res = await ctx.client.skills.list();
    if (!res.ok) return pluginFailureResponse(res);
    return NextResponse.json({
      skills: res.data.skills,
      canManage: ctx.isGatewayOwner && ctx.capabilityReady,
      capabilityReady: ctx.capabilityReady,
      sharedChannelCount: await sharedChannelCount(ctx),
    });
  }

  const found = match(req.method, path);
  if (!found) return cronError(404, "not_found", "Unknown skill route");
  const gate = requireCapability(ctx) ?? (found.row.access === "owner" ? requireOwner(ctx) : null);
  if (gate) return gate;
  const body = await readBody(req);
  const out = await found.row.handler(ctx, {
    args: found.args,
    body,
    sp: req.nextUrl.searchParams,
  });
  return relay(out, found.row.okStatus ?? 200);
}
