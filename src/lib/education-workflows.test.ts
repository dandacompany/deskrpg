import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { setupThrowawaySqlite } from "@/test-setup/npc-seed";

setupThrowawaySqlite("education-workflows-test");

test("shared workflow persists all stages, versions, events and idempotent retries", async () => {
  const { createEducationWorkflow, getEducationWorkflow, listEducationWorkflows, updateEducationWorkflow } = await import("@/lib/education-workflows");
  const created = await createEducationWorkflow({
    title: "AI 활용 보안 교육", requestText: "공개 자료로 60분 교육안 작성", source: "deskrpg",
    idempotencyKey: `create:${randomUUID()}`, actor: "test-user",
  });
  assert.equal(created.workflow.version, 0);
  const duplicateCreate = await createEducationWorkflow({
    title: "AI 활용 보안 교육", requestText: "공개 자료로 60분 교육안 작성", source: "slack",
    idempotencyKey: created.workflow.idempotencyKey as string, actor: "Sophie",
  });
  assert.equal(duplicateCreate.duplicate, true);
  assert.equal(duplicateCreate.workflow.id, created.workflow.id);

  const update = async (action: string, payload: Record<string, unknown> = {}) => {
    const current = await getEducationWorkflow(created.workflow.id as string);
    assert.ok(current);
    return updateEducationWorkflow({
      id: created.workflow.id as string, expectedVersion: current.version, eventId: randomUUID(),
      action, payload, source: "slack", actor: "Sophie · Slack",
    });
  };
  await update("save_candidates", { candidates: [{ id: "topic-1", title: "안전한 AI 활용", rationale: "실무 보안교육 수요" }] });
  await update("choose_topic", { candidateId: "topic-1" });
  await update("save_brief", { audience: "임직원", objective: "위험 식별", durationMinutes: 60, deliverable: "교육안·PPTX" });
  await update("select_team", { team: ["atlas", "guard"] });
  await update("start_research");
  await update("save_research", { summary: "공식 자료 조사", sources: [{ title: "Example", url: "https://example.com", note: "공개 문서" }] });
  await update("approve_research");
  await update("save_outline", { outline: ["위험", "대응"] });
  await update("approve_outline");
  await update("save_cards", { cards: ["민감정보 입력 전 검토"] });
  await update("save_document", { documentDraft: "# 교육안" });
  const beforeApproval = await getEducationWorkflow(created.workflow.id as string);
  assert.ok(beforeApproval);
  const approvalEventId = randomUUID();
  const approval = {
    id: created.workflow.id as string, expectedVersion: beforeApproval.version, eventId: approvalEventId,
    action: "approve_final", payload: {}, source: "slack" as const, actor: "Sophie · Slack",
  };
  const approved = await updateEducationWorkflow(approval);
  assert.equal(approved.workflow.status, "approved");
  assert.equal(approved.workflow.version, 12);
  const retry = await updateEducationWorkflow({
    ...approval,
  });
  assert.equal(approved.workflow.version, retry.workflow.version);
  assert.equal(retry.duplicate, true);

  const detail = await getEducationWorkflow(created.workflow.id as string);
  assert.equal(detail?.events.length, 13);
  assert.equal((detail?.state.selectedTopic as { title: string }).title, "안전한 AI 활용");
  const [summary] = await listEducationWorkflows();
  assert.equal(summary.id, created.workflow.id);
  assert.equal("requestText" in summary, false);
  assert.equal("state" in summary, false);
});

test("rejects invalid stage transitions and event ID reuse with a different update", async () => {
  const { createEducationWorkflow, updateEducationWorkflow } = await import("@/lib/education-workflows");
  const created = await createEducationWorkflow({
    title: "전이 검사", requestText: "stage guard", source: "deskrpg", idempotencyKey: `create:${randomUUID()}`, actor: "test-user",
  });
  const eventId = randomUUID();
  await assert.rejects(updateEducationWorkflow({
    id: created.workflow.id as string, expectedVersion: 0, eventId, action: "save_outline",
    payload: { outline: ["잘못된 시점"] }, source: "slack", actor: "Sophie",
  }), (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "invalid_stage_transition");
  const { updateEducationWorkflow: update } = await import("@/lib/education-workflows");
  await update({ id: created.workflow.id as string, expectedVersion: 0, eventId, action: "pause", payload: {}, source: "slack", actor: "Sophie" });
  await assert.rejects(update({
    id: created.workflow.id as string, expectedVersion: 0, eventId, action: "resume", payload: {}, source: "slack", actor: "Sophie",
  }), (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "event_id_reused");
});
