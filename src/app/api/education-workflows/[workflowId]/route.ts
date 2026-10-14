import { NextRequest, NextResponse } from "next/server";
import { getUserId } from "@/lib/internal-rpc";
import { readJsonObject, invalidJsonBody } from "@/lib/api-body";
import { EducationWorkflowError, getEducationWorkflow, updateEducationWorkflow } from "@/lib/education-workflows";

type Params = { params: Promise<{ workflowId: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  if (!getUserId(req)) return NextResponse.json({ errorCode: "unauthorized" }, { status: 401 });
  const { workflowId } = await params;
  const workflow = await getEducationWorkflow(workflowId);
  return workflow
    ? NextResponse.json({ workflow })
    : NextResponse.json({ errorCode: "workflow_not_found" }, { status: 404 });
}

export async function POST(req: NextRequest, { params }: Params) {
  const userId = getUserId(req);
  if (!userId) return NextResponse.json({ errorCode: "unauthorized" }, { status: 401 });
  const body = await readJsonObject(req);
  if (!body) return invalidJsonBody();
  const { workflowId } = await params;
  try {
    const result = await updateEducationWorkflow({
      id: workflowId, expectedVersion: body.expectedVersion, eventId: req.headers.get("idempotency-key"),
      action: body.action, payload: body.payload, source: "deskrpg", actor: `user:${userId}`,
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof EducationWorkflowError) {
      return NextResponse.json({ errorCode: error.code, current: error.current }, { status: error.status });
    }
    return NextResponse.json({ errorCode: "education_workflow_update_failed" }, { status: 500 });
  }
}
