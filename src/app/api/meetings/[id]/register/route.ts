import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db, channels, jsonForDb, meetingMinutes } from "@/db";
import { formatRequester } from "@/lib/approval-requester";
import { createApprovalBatch } from "@/lib/approvals";
import { getUserId } from "@/lib/internal-rpc";
import { resolveKanbanChannelContext, reviewPolicyFailure } from "@/lib/kanban-access";
import { markMeetingOutcomeNoticeRegistered } from "@/lib/meeting-outcome-notice";
import { normalizeMeetingMinutesRecord } from "@/lib/meeting-minutes";
import { registerMeetingOutcome } from "@/lib/meeting-register";
import { createSubproject, ensureProjectRow, ProjectRegistryError } from "@/lib/project-registry";

/**
 * Register the follow-up work from a meeting's result — cards stand awaiting approval and execution starts after approval.
 * All the judgment lives in `registerMeetingOutcome`. This only plugs in the real DB and Hermes.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = getUserId(req);
  if (!userId) {
    return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json(
      { errorCode: "nothing_to_register", error: "nothing_to_register" },
      { status: 400 },
    );
  }

  try {
    const result = await registerMeetingOutcome(
      { minutesId: id, userId, body },
      {
        loadMinutes: async (minutesId) => {
          const [row] = await db
            .select()
            .from(meetingMinutes)
            .where(eq(meetingMinutes.id, minutesId))
            .limit(1);
          return row ? normalizeMeetingMinutesRecord(row) : null;
        },
        loadChannelOwner: async (channelId) => {
          const [channel] = await db
            .select({ ownerId: channels.ownerId })
            .from(channels)
            .where(eq(channels.id, channelId))
            .limit(1);
          return channel?.ownerId ?? null;
        },
        resolveContext: async (input) => {
          const resolved = await resolveKanbanChannelContext(input);
          if (!resolved.ok) return resolved;
          const failure = reviewPolicyFailure(resolved.ctx);
          return failure ? { ok: false as const, response: failure } : resolved;
        },
        ensureSubproject: async (ctx, tenant, minutesId) => {
          const project = await ensureProjectRow(ctx.boardRow);
          try {
            await createSubproject(project, {
              tenantSlug: tenant.slug,
              name: tenant.name,
              originMeetingId: minutesId,
            });
          } catch (err) {
            // The same slug already exists — either registering into an existing subproject or a retry. Use it as is.
            if (err instanceof ProjectRegistryError && err.code === "subproject_exists") return;
            throw err;
          }
        },
        createBatch: (ctx, input) => createApprovalBatch(ctx, input),
        saveRegistered: async (minutesId, registered) => {
          const [row] = await db
            .select({
              outcomeJson: meetingMinutes.outcomeJson,
              channelId: meetingMinutes.channelId,
            })
            .from(meetingMinutes)
            .where(eq(meetingMinutes.id, minutesId))
            .limit(1);
          const outcome = row ? normalizeMeetingMinutesRecord(row).outcome : null;
          if (!outcome) return;
          await db
            .update(meetingMinutes)
            .set({ outcomeJson: jsonForDb({ ...outcome, registered }) })
            .where(eq(meetingMinutes.id, minutesId));
          // Make the office room's "프로젝트로 등록할까요?" line report the result. Do not throw.
          await markMeetingOutcomeNoticeRegistered({
            channelId: row.channelId,
            minutesId,
            registered,
          });
        },
        requesterForUser: (id) => formatRequester({ kind: "user", userId: id }),
        now: () => new Date().toISOString(),
      },
    );

    if (result.ok) {
      return NextResponse.json({ registered: result.registered, approvalId: result.approvalId });
    }
    // Kanban gate refusals (409, 428, 404, 503) are returned in their shape as is.
    if ("response" in result) return result.response;
    return NextResponse.json(
      {
        errorCode: result.errorCode,
        error: result.errorCode,
        ...(result.failed ? { failed: result.failed } : {}),
      },
      { status: result.status },
    );
  } catch (err) {
    console.error("Failed to register meeting outcome:", err);
    return NextResponse.json(
      { errorCode: "failed_to_register_meeting", error: "Failed to register meeting outcome" },
      { status: 500 },
    );
  }
}
