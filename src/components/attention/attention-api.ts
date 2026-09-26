/**
 * Browser-side calls for the attention inbox REST endpoint (`/api/channels/:id/attention`).
 *
 * Same convention as Kanban — a same-origin DeskRPG route, session cookies, and on failure
 * we throw the server's `{code, message}` as-is. No translating or folding happens here.
 */
import type { AttentionRow } from "@/lib/attention-inbox";
import type { AttentionCounts } from "@/lib/needs-attention";

export type AttentionInbox = { rows: AttentionRow[]; counts: AttentionCounts };

export class AttentionApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "AttentionApiError";
    this.status = status;
    this.code = code;
  }
}

async function unwrap(res: Response): Promise<unknown> {
  const body = await res.json().catch(() => null);
  if (res.ok) return body;
  const failure = (body ?? {}) as { code?: string; message?: string };
  throw new AttentionApiError(res.status, failure.code ?? "unknown", failure.message ?? "failed");
}

export function createAttentionApi(channelId: string) {
  const base = `/api/channels/${encodeURIComponent(channelId)}`;
  return {
    async load(signal?: AbortSignal): Promise<AttentionInbox> {
      return (await unwrap(await fetch(`${base}/attention`, { signal }))) as AttentionInbox;
    },
    async decide(
      approvalId: string,
      body: {
        decision: "approve" | "reject" | "request_revision";
        note?: string;
        targets?: { task_id: string; decision: string }[];
      },
    ): Promise<unknown> {
      return unwrap(
        await fetch(`${base}/approvals/${encodeURIComponent(approvalId)}/decide`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    },
    /** Answers an NPC's question (only its own user may). Throws the server's `{code}` on failure. */
    async answerQuestion(questionId: string, npcId: string, response: string): Promise<unknown> {
      return unwrap(
        await fetch(`${base}/attention/questions/${encodeURIComponent(questionId)}/answer`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ npcId, response }),
        }),
      );
    },
  };
}
