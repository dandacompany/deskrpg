/**
 * The fake plugin server's `ask_user` routes — **test only**. Mimics the plugin's paths, status codes
 * and fields (`deskrpg_plugin/ask_user.py`). The waiting tool itself lives in Hermes; tests stand in for
 * it with `seedQuestion`.
 */
import type { NpcQuestion } from "./plugin-client-types";

export type FakeAskUserState = {
  /** session_id → the context DeskRPG registered with it. */
  sessions: Map<string, Record<string, unknown>>;
  questions: Map<string, NpcQuestion>;
  /** question id → the response it received. */
  answers: Map<string, string>;
};

type Req = { method: string; pathname: string; json: unknown; params: URLSearchParams };
type Reply = { status: number; body: unknown };

const err = (status: number, error: string): Reply => ({ status, body: { error } });

export function createFakeAskUserState(): FakeAskUserState {
  return { sessions: new Map(), questions: new Map(), answers: new Map() };
}

let seq = 0;

/** What the tool does when a registered session asks: a pending question carrying that session's context. */
export function seedQuestion(
  state: FakeAskUserState,
  input: { sessionId: string; question: string; choices: string[]; allowOther?: boolean },
): NpcQuestion {
  seq += 1;
  const question: NpcQuestion = {
    id: `q${seq}`,
    session_id: input.sessionId,
    question: input.question,
    choices: input.choices,
    allow_other: input.allowOther ?? true,
    created_at: new Date(Date.UTC(2026, 8, 26, 0, 0, seq)).toISOString(),
    context: state.sessions.get(input.sessionId) ?? {},
  };
  state.questions.set(question.id, question);
  return question;
}

export function routeAskUser(state: FakeAskUserState, req: Req): Reply | null {
  const body = (req.json ?? {}) as Record<string, unknown>;
  if (req.pathname === "/deskrpg/ask-user/sessions" && req.method === "POST") {
    if (typeof body.session_id !== "string" || !body.session_id) return err(400, "invalid_field");
    const context = body.context ?? {};
    if (typeof context !== "object" || context === null || Array.isArray(context))
      return err(400, "invalid_field");
    state.sessions.set(body.session_id, context as Record<string, unknown>);
    return { status: 200, body: { registered: true } };
  }
  if (req.pathname === "/deskrpg/questions" && req.method === "GET") {
    const session = req.params.get("session_id");
    const questions = [...state.questions.values()].filter(
      (q) => !session || q.session_id === session,
    );
    return { status: 200, body: { questions } };
  }
  const m = /^\/deskrpg\/questions\/([^/]+)\/answer$/.exec(req.pathname);
  if (m && req.method === "POST") {
    const question = state.questions.get(decodeURIComponent(m[1]));
    if (!question) return err(404, "question_not_found");
    const response = typeof body.response === "string" ? body.response.trim() : "";
    if (!response || (!question.allow_other && !question.choices.includes(response)))
      return err(400, "invalid_response");
    state.questions.delete(question.id);
    state.answers.set(question.id, response);
    return { status: 200, body: { answered: true } };
  }
  return null;
}
