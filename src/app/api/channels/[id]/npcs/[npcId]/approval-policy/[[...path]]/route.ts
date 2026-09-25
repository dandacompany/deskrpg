// NPC unattended run policy REST — the handler is `@/lib/approval-policy-routes`.
import type { NextRequest } from "next/server";

import { handleApprovalPolicyRoute } from "@/lib/approval-policy-routes";

type Ctx = { params: Promise<{ id: string; npcId: string; path?: string[] }> };

const handle = async (req: NextRequest, { params }: Ctx) =>
  handleApprovalPolicyRoute(req, await params);

export const GET = handle;
export const PUT = handle;
export const POST = handle;
export const DELETE = handle;
