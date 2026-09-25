import { withStreamDiagnosticRequest } from "@/lib/hermes/stream-diagnostics";
import { createTurnTimeout } from "@/lib/conversation/turn-timeout";
import type { ChatResponse } from "@/lib/chat-response";
import { ChatResponseTracker, SessionQueue } from "./chat-response-tracker";

type Identity = Pick<ChatResponse, "requestId" | "sourceMessageId" | "npcId" | "npcName">;
export type DmCapture = (
  event: string,
  payload: {
    npcId?: string;
    chunk?: string;
    done?: boolean;
    messageCode?: string;
    activityKey?: string;
  },
) => void;

/** Couples admission, queue and terminal state; callers still own authorization and persistence. */
export async function runTrackedDm(args: {
  tracker: ChatResponseTracker;
  queue: SessionQueue;
  queueKey: string;
  identity: Identity;
  prepare?: () => Promise<unknown>;
  work: (
    capture: DmCapture,
    isActive: () => boolean,
    signal?: AbortSignal,
  ) => Promise<string | void>;
}): Promise<void> {
  const { tracker, queue, queueKey, identity } = args;
  if (queue.isFull(queueKey)) throw new Error("queue_full");
  tracker.accept(identity);
  // Reserve FIFO synchronously; source writes may run concurrently, but are always awaited
  // before execution/cancellation completes. Rejections are captured even while queued.
  const preparation = Promise.resolve()
    .then(() => args.prepare?.())
    .then(
      () => null,
      (error: unknown) => error,
    );
  const isActive = () => tracker.isActive(identity.requestId);
  await queue.run(queueKey, async () => {
    const preparationError = await preparation;
    if (!isActive()) return;
    if (preparationError) {
      tracker.update(identity.requestId, { status: "failed", error: "persistence_error" });
      return;
    }
    tracker.update(identity.requestId, { status: "thinking" });
    let raw = "";
    let failure: string | undefined;
    try {
      const response = await withStreamDiagnosticRequest(identity.requestId, () =>
        args.work(
          (event, payload) => {
            if (!isActive() || event !== "npc:response" || payload.npcId !== identity.npcId) return;
            if (payload.messageCode && payload.done) failure = payload.messageCode;
            if (payload.chunk) {
              raw += payload.chunk;
              const content = raw.trim();
              if (content) tracker.update(identity.requestId, { status: "streaming", content });
            }
          },
          isActive,
          tracker.signal(identity.requestId),
        ),
      );
      if (!isActive()) return;
      const content = (response ?? "").trim();
      if (failure || !content) {
        tracker.update(identity.requestId, {
          status: "failed",
          error: failure ?? "empty_response",
        });
      } else {
        tracker.update(identity.requestId, {
          status: "complete",
          content,
          messageId: identity.requestId,
        });
      }
    } catch {
      tracker.update(identity.requestId, { status: "failed", error: "adapter_error" });
    }
  });
}

/** A silent backend must not hold the DM queue forever. Ignore callbacks after timeout. */
export function executeDmAdapter(
  adapter: import("@/lib/adapters/types").NpcAdapter,
  options: import("@/lib/adapters/types").AdapterExecuteOptions,
  config = { idleMs: 180_000, maxMs: 600_000 },
  signal?: AbortSignal,
): ReturnType<import("@/lib/adapters/types").NpcAdapter["execute"]> {
  return new Promise((resolve, reject) => {
    let finished = false;
    const abort = () => {
      if (finished) return;
      finished = true;
      timeout.clear();
      void adapter.abort?.(options.sessionKey)?.catch(() => {});
      reject(new Error("DM cancelled"));
    };
    const timeout = createTurnTimeout(config, (kind) => {
      finished = true;
      signal?.removeEventListener("abort", abort);
      void adapter.abort?.(options.sessionKey)?.catch(() => {});
      reject(new Error(`DM timeout (${kind})`));
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    Promise.resolve()
      .then(() => {
        if (finished) throw new Error("DM cancelled");
        return adapter.execute({
          ...options,
          onDelta: (chunk) => {
            if (!finished) {
              timeout.touch();
              options.onDelta?.(chunk);
            }
          },
          onToolProgress: (name, delta) => {
            if (!finished) {
              timeout.touch();
              options.onToolProgress?.(name, delta);
            }
          },
          onRunStarted: (id) => {
            if (!finished) {
              timeout.touch();
              options.onRunStarted?.(id);
            }
          },
          // Waiting for the user's approval is silent; the next progress event re-arms idle.
          onApprovalRequest: (event) => {
            if (!finished) {
              timeout.hold();
              options.onApprovalRequest?.(event);
            }
          },
        });
      })
      .then(
        (result) => {
          if (finished) return;
          finished = true;
          timeout.clear();
          signal?.removeEventListener("abort", abort);
          resolve(result);
        },
        (error) => {
          if (finished) return;
          finished = true;
          timeout.clear();
          signal?.removeEventListener("abort", abort);
          reject(error);
        },
      );
  });
}
