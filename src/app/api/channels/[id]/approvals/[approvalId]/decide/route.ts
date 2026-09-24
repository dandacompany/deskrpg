// POST /api/channels/:id/approvals/:approvalId/decide — {decision, note?, targets?} (channel members)
import type { NextRequest } from "next/server";

import { decideApproval, type ApprovalParams } from "@/lib/approval-routes";

export async function POST(req: NextRequest, { params }: ApprovalParams) {
  const { id, approvalId } = await params;
  return decideApproval(req, id, approvalId);
}
