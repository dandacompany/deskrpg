// POST /api/channels/:id/attention/questions/:questionId/answer — answer an NPC's question (its own user only)
import type { NextRequest } from "next/server";

import { postQuestionAnswer } from "@/lib/attention-routes";

type Params = { params: Promise<{ id: string; questionId: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  const { id, questionId } = await params;
  return postQuestionAnswer(req, id, questionId);
}
