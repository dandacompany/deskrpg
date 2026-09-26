// GET  /api/channels/:id/report-acks → {ack: {through, ids} | null} (channel members)
// POST /api/channels/:id/report-acks — {messageId} acknowledges one report,
//      or {import: {through, ids}} brings a browser's old record in (merged) → {ack}
//
// Which "보고 N건" items this user has dealt with. It used to live in each browser's localStorage,
// so the count differed per device; `ack: null` tells the client it may import what it still holds.
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import {
  acknowledgeReportFor,
  importReportAck,
  loadReportAck,
  type StoredReportAck,
} from "@/lib/conversation-reads";
import { cronError, requireChannelMember } from "@/lib/cron-access";
import { getUserId } from "@/lib/internal-rpc";

type Params = { params: Promise<{ id: string }> };

async function resolve(req: NextRequest, params: Params["params"]) {
  const userId = getUserId(req);
  if (!userId)
    return { ok: false as const, response: cronError(401, "unauthorized", "unauthorized") };
  const { id: channelId } = await params;
  const access = await requireChannelMember(channelId, userId);
  if (!access.ok) return access;
  return { ok: true as const, userId, channelId };
}

function parseImport(value: unknown): StoredReportAck | null {
  if (!value || typeof value !== "object") return null;
  const { through, ids } = value as { through?: unknown; ids?: unknown };
  if (through !== null && (typeof through !== "string" || Number.isNaN(Date.parse(through))))
    return null;
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string" && id.length > 0))
    return null;
  return { through, ids };
}

export async function GET(req: NextRequest, { params }: Params) {
  const resolved = await resolve(req, params);
  if (!resolved.ok) return resolved.response;
  return NextResponse.json({ ack: await loadReportAck(resolved.userId, resolved.channelId) });
}

export async function POST(req: NextRequest, { params }: Params) {
  const resolved = await resolve(req, params);
  if (!resolved.ok) return resolved.response;
  const body = (await req.json().catch(() => null)) as {
    messageId?: unknown;
    import?: unknown;
  } | null;

  if (typeof body?.messageId === "string" && body.messageId.length > 0) {
    const ack = await acknowledgeReportFor(resolved.userId, resolved.channelId, body.messageId);
    return NextResponse.json({ ack });
  }
  const incoming = parseImport(body?.import);
  if (incoming) {
    const ack = await importReportAck(resolved.userId, resolved.channelId, incoming);
    return NextResponse.json({ ack });
  }
  return cronError(400, "invalid_body", "messageId or import {through, ids} is required");
}
