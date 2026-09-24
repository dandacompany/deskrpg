// Pins the approval batch lookup (isApprovalBatchCard) against a real DB. Unit tests use fake dependencies, so
// the property "true if the card was ever in a batch, regardless of approval state" is only visible here.
import test from "node:test";
import assert from "node:assert/strict";

import { seedChannel, seedUser, setupThrowawaySqlite } from "@/test-setup/npc-seed";

setupThrowawaySqlite("automation-approval-db");

async function seedApproval(channelId: string, status: string, taskIds: string[]) {
  const { db, approvals, approvalTargets } = await import("@/db");
  const [row] = await db
    .insert(approvals)
    .values({
      id: crypto.randomUUID(),
      channelId,
      type: "task_execution",
      status,
      requestedBy: "user:someone",
      title: `묶음 ${status}`,
      sourceJson: JSON.stringify({ kind: "meeting" }),
    })
    .returning({ id: approvals.id });
  await db
    .insert(approvalTargets)
    .values(taskIds.map((taskId) => ({ approvalId: row.id, taskId })));
}

test("true for a card that was in an approval batch regardless of approval state, false otherwise, ignoring other channels' batches", async () => {
  const owner = await seedUser("appr-db");
  const channel = await seedChannel(owner.id, "승인 채널");
  const other = await seedChannel(owner.id, "다른 채널");
  await seedApproval(channel.id, "pending", ["t-pending"]);
  await seedApproval(channel.id, "approved", ["t-approved"]);
  // Even if a card from a rejected or change-requested batch is later released by hand and finished, it is an independent task a person saw in the list.
  await seedApproval(channel.id, "rejected", ["t-rejected"]);
  await seedApproval(channel.id, "revision_requested", ["t-revision"]);
  await seedApproval(other.id, "approved", ["t-elsewhere"]);

  const { createLiveIngestDeps } = await import("./automation-events");
  const deps = createLiveIngestDeps({ gatewayId: "g", boardSlug: "b" } as never);
  const ask = (taskId: string) => deps.isApprovalBatchCard!(channel.id, taskId);

  for (const id of ["t-pending", "t-approved", "t-rejected", "t-revision"]) {
    assert.equal(await ask(id), true, `${id} 는 묶음 카드다`);
  }
  assert.equal(await ask("swarm-child"), false);
  assert.equal(
    await ask("t-elsewhere"),
    false,
    "다른 채널의 묶음으로 이 채널 카드를 판정하지 않는다",
  );
});
