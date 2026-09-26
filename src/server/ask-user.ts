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

/**
 * Sent on every 1:1 run's instructions. Hermes freezes plugin prompt sections into a session's stored
 * system prompt, and a 1:1 session lives forever — so the plugin's own section never reaches a
 * conversation that began before it. Instructions are injected per call and never cached.
 */
export const ASK_USER_INSTRUCTIONS = `## Asking the user with choices

When you need information only the user has, and the answer can be narrowed to 2-4 choices, call
\`${ASK_USER_TOOL}\` with the question and the choices, then wait for the answer it returns and continue.
If it is not among your listed tools, find it with tool_search and call it through the tool-call bridge.
Ask open questions (ones without a short list of answers) in plain text instead. One question per call.`;

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
    // Without ask_user the run is untouched: no guidance, no registration, no polling.
    if (!(await deps.canAsk(route.npcId).catch(() => false))) return adapter.execute(options);
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
        instructions: [options.instructions, ASK_USER_INSTRUCTIONS].filter(Boolean).join("\n\n"),
        onRunStarted: (runId: string) => {
          options.onRunStarted?.(runId);
          session = (async () => {
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
