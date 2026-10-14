import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { setupThrowawaySqlite } from "@/test-setup/npc-seed";

setupThrowawaySqlite("education-workflow-internal-route-test");

function request(body: Record<string, unknown>, token?: string) {
  return new NextRequest("http://localhost/api/internal/education-workflows", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

test("internal workflow route requires its service token and supports Slack sync operations", async () => {
  const oldToken = process.env.DESKRPG_EDUCATION_WORKFLOW_TOKEN;
  const token = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
  process.env.DESKRPG_EDUCATION_WORKFLOW_TOKEN = token;
  try {
    const { POST } = await import("@/app/api/internal/education-workflows/route");
    const unauthorized = await POST(request({ operation: "list" }));
    assert.equal(unauthorized.status, 401);

    const created = await POST(request({
      operation: "create", title: "공용 교육", requestText: "보안 교육안", idempotencyKey: `create:${randomUUID()}`, sessionId: "slack-thread-1",
    }, token));
    assert.equal(created.status, 201);
    const createData = await created.json();
    assert.equal(createData.workflow.source, "slack");
    assert.equal(createData.workflow.externalSessionId, "slack-thread-1");

    const listed = await POST(request({ operation: "list" }, token));
    const listData = await listed.json();
    assert.equal(listData.workflows[0].id, createData.workflow.id);
    assert.equal("requestText" in listData.workflows[0], false);

    const eventId = randomUUID();
    const updated = await POST(request({
      operation: "update", workflowId: createData.workflow.id, expectedVersion: 0, eventId,
      action: "save_candidates", payload: { candidates: [{ id: "one", title: "보안 교육", rationale: "요청과 부합" }] },
    }, token));
    assert.equal(updated.status, 200);

    const detail = await POST(request({ operation: "get", workflowId: createData.workflow.id }, token));
    const detailData = await detail.json();
    assert.equal(detailData.workflow.version, 1);
    assert.equal(detailData.workflow.events.length, 2);
  } finally {
    if (oldToken === undefined) delete process.env.DESKRPG_EDUCATION_WORKFLOW_TOKEN;
    else process.env.DESKRPG_EDUCATION_WORKFLOW_TOKEN = oldToken;
  }
});
