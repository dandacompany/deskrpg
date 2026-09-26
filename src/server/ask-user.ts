/**
 * NPC questions in 1:1 chat (`deskrpg_ask_user`). Wraps an NPC adapter the way `withToolApprovals`
 * does: when the run starts, its Hermes session is registered with the plugin (without that the tool
 * answers "no user" at once); when the tool starts, the question it waits on is read and sent to that
 * user only; when the run ends, any card still open is closed — the tool can't be answered any more.
 *
 * Answers don't pass through here. They go to the plugin (`answerNpcQuestion`), which releases the
 * waiting tool; the run then continues on its own.
 */
import { replaceExecute } from "@/lib/adapters/replace-execute";
import type { AdapterExecuteOptions, NpcAdapter } from "@/lib/adapters/types";
import type { AskUserContext, UserQuestion } from "@/lib/npc-questions";

export const ASK_USER_TOOL = "deskrpg_ask_user";
export const NPC_QUESTION_EVENTS = {
  question: "npc:question",
  closed: "npc:questions-closed",
  answer: "npc:answer",
  answered: "npc:question-answered",
} as const;

/** `tool.started` arrives before the tool has stored its question; look a few times. */
const POLL_ATTEMPTS = 20;
const DEFAULT_POLL_INTERVAL_MS = 300;

export type AskUserDeps = {
  canAsk(npcId: string): Promise<boolean>;
  sessionIdOf(npcId: string, runId: string): Promise<string | null>;
  register(input: AskUserContext & { sessionId: string }): Promise<boolean>;
  questions(input: { npcId: string; userId: string; sessionId: string }): Promise<UserQuestion[]>;
  /** Emits to the chat's user only. */
  emit(event: string, payload: unknown): void;
  pollIntervalMs?: number;
};

export function withAskUser(
  adapter: NpcAdapter,
  route: AskUserContext,
  deps: AskUserDeps,
): NpcAdapter {
  const interval = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const execute: NpcAdapter["execute"] = async (options: AdapterExecuteOptions) => {
    let session: Promise<string | null> = Promise.resolve(null);
    const shown = new Set<string>();
    const polls: Promise<void>[] = [];

    const lookFor = async () => {
      const sessionId = await session;
      if (!sessionId) return;
      for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
        const fresh = (
          await deps.questions({ npcId: route.npcId, userId: route.userId, sessionId })
        ).filter((q) => !shown.has(q.id));
        for (const question of fresh) {
          shown.add(question.id);
          deps.emit(NPC_QUESTION_EVENTS.question, { npcId: route.npcId, question });
        }
        if (fresh.length > 0) return;
        await new Promise((r) => setTimeout(r, interval));
      }
    };

    try {
      return await adapter.execute({
        ...options,
        onRunStarted: (runId: string) => {
          options.onRunStarted?.(runId);
          session = (async () => {
            if (!(await deps.canAsk(route.npcId))) return null;
            const sessionId = await deps.sessionIdOf(route.npcId, runId);
            if (!sessionId) return null;
            return (await deps.register({ ...route, sessionId })) ? sessionId : null;
          })().catch(() => null);
        },
        onToolProgress: (toolName: string, preview: string) => {
          options.onToolProgress?.(toolName, preview);
          if (toolName === ASK_USER_TOOL) polls.push(lookFor().catch(() => undefined));
        },
      });
    } finally {
      await session;
      await Promise.allSettled(polls);
      if (shown.size > 0)
        deps.emit(NPC_QUESTION_EVENTS.closed, { npcId: route.npcId, questionIds: [...shown] });
    }
  };
  return replaceExecute(adapter, execute);
}
