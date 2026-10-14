import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { readJsonObject, invalidJsonBody } from "@/lib/api-body";
import {
  createEducationWorkflow, EducationWorkflowError, getEducationWorkflow, listEducationWorkflows,
  updateEducationWorkflow,
} from "@/lib/education-workflows";

function authorized(req: NextRequest): boolean {
  const expected = process.env.DESKRPG_EDUCATION_WORKFLOW_TOKEN ?? "";
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9._:-]{32,256})$/.exec(header);
  if (!expected || !match) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(match[1]);
  return a.length === b.length && timingSafeEqual(a, b);
}

function mapError(error: unknown) {
  if (error instanceof EducationWorkflowError) {
    return NextResponse.json({ errorCode: error.code, current: error.current }, { status: error.status });
  }
  return NextResponse.json({ errorCode: "education_workflow_request_failed" }, { status: 500 });
}

export async function POST(req: NextRequest) {
  if (!process.env.DESKRPG_EDUCATION_WORKFLOW_TOKEN) {
    return NextResponse.json({ errorCode: "service_token_unconfigured" }, { status: 503 });
  }
  if (!authorized(req)) return NextResponse.json({ errorCode: "unauthorized" }, { status: 401 });
  const body = await readJsonObject(req);
  if (!body) return invalidJsonBody();
  const operation = body.operation;
  try {
    if (operation === "list") return NextResponse.json({ workflows: await listEducationWorkflows(50) });
    if (operation === "get") {
      if (typeof body.workflowId !== "string") return NextResponse.json({ errorCode: "workflow_id_required" }, { status: 400 });
      const workflow = await getEducationWorkflow(body.workflowId);
      return workflow ? NextResponse.json({ workflow }) : NextResponse.json({ errorCode: "workflow_not_found" }, { status: 404 });
    }
    if (operation === "create") {
      const sessionId = typeof body.sessionId === "string" ? body.sessionId.slice(0, 255) : null;
      const result = await createEducationWorkflow({
        title: body.title, requestText: body.requestText, source: "slack", externalSessionId: sessionId,
        idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : "",
        actor: "Sophie · Slack",
      });
      return NextResponse.json(result, { status: result.duplicate ? 200 : 201 });
    }
    if (operation === "update") {
      if (typeof body.workflowId !== "string") return NextResponse.json({ errorCode: "workflow_id_required" }, { status: 400 });
      const result = await updateEducationWorkflow({
        id: body.workflowId, expectedVersion: body.expectedVersion, eventId: body.eventId,
        action: body.action, payload: body.payload, source: "slack", actor: "Sophie · Slack",
      });
      return NextResponse.json(result);
    }
    return NextResponse.json({ errorCode: "unknown_operation" }, { status: 400 });
  } catch (error) {
    return mapError(error);
  }
}
