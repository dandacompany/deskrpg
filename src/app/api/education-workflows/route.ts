import { NextRequest, NextResponse } from "next/server";
import { getUserId } from "@/lib/internal-rpc";
import { readJsonObject, invalidJsonBody } from "@/lib/api-body";
import { createEducationWorkflow, listEducationWorkflows, EducationWorkflowError } from "@/lib/education-workflows";

export async function GET(req: NextRequest) {
  if (!getUserId(req)) return NextResponse.json({ errorCode: "unauthorized" }, { status: 401 });
  const limit = Number(req.nextUrl.searchParams.get("limit") ?? 50);
  try {
    return NextResponse.json({ workflows: await listEducationWorkflows(Number.isFinite(limit) ? limit : 50) });
  } catch {
    return NextResponse.json({ errorCode: "education_workflows_unavailable" }, { status: 503 });
  }
}

export async function POST(req: NextRequest) {
  const userId = getUserId(req);
  if (!userId) return NextResponse.json({ errorCode: "unauthorized" }, { status: 401 });
  const body = await readJsonObject(req);
  if (!body) return invalidJsonBody();
  const idempotencyKey = req.headers.get("idempotency-key") ?? "";
  try {
    const result = await createEducationWorkflow({
      title: body.title, requestText: body.requestText, source: "deskrpg", idempotencyKey,
      createdByUserId: userId, actor: `user:${userId}`,
    });
    return NextResponse.json(result, { status: result.duplicate ? 200 : 201 });
  } catch (error) {
    if (error instanceof EducationWorkflowError) return NextResponse.json({ errorCode: error.code }, { status: error.status });
    return NextResponse.json({ errorCode: "education_workflow_create_failed" }, { status: 500 });
  }
}
