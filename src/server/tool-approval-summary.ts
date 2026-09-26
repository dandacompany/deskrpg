/**
 * A plain-language line on a tool approval card, in the approver's language. The NPC whose run is
 * waiting writes it in a separate, stateless run — it knows what it was trying to do, and the
 * approver reads Hermes' own English only if they open it.
 *
 * The reply is untrusted text shown next to buttons that run a command, so it is redacted here on
 * the server: no stretch of the command, no code, no URLs, nothing shaped like a secret. When no
 * summary can be made in time the card simply shows Hermes' text.
 */
import { HermesAdapter } from "@/lib/adapters/hermes-adapter";
import { getProfileClientForNpc } from "@/lib/hermes-profiles";
import { languageName } from "@/lib/i18n/prompt-locale";

import type { PendingApproval } from "./tool-approvals";

export const APPROVAL_SUMMARY_TIMEOUT_MS = 20_000;
const MAX_SUMMARY_CHARS = 200;
/** Any run of the command at least this long counts as quoting it. */
const MIN_QUOTED_RUN = 12;

const SECRET_PATTERNS = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  /\bBearer\s+\S+/gi,
  // Long opaque strings: keys, hashes, base64 blobs.
  /[A-Za-z0-9+/_=-]{32,}/g,
];

/** Removes every stretch of `command` of at least MIN_QUOTED_RUN characters from `text`. */
function stripCommandRuns(text: string, command: string): string {
  const source = command.trim();
  if (source.length < MIN_QUOTED_RUN) return source ? text.split(source).join(" … ") : text;
  let out = text;
  for (let start = 0; start + MIN_QUOTED_RUN <= source.length; start += 1) {
    let end = start + MIN_QUOTED_RUN;
    if (!out.includes(source.slice(start, end))) continue;
    while (end < source.length && out.includes(source.slice(start, end + 1))) end += 1;
    out = out.split(source.slice(start, end)).join(" … ");
    start = end - 1;
  }
  return out;
}

export function redactApprovalSummary(raw: string, command: string): string | null {
  let text = raw.split(/\r?\n/).find((line) => line.trim()) ?? "";
  text = text.replace(/`[^`]*`/g, " … ").replace(/https?:\/\/\S+/gi, " … ");
  // Secrets first: stripping part of the command first could cut a key in half and leave its prefix.
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, " … ");
  text = stripCommandRuns(text, command);
  text = text
    .replace(/(?:\s*…\s*)+/g, " … ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text.replace(/[…\s.,:;!?-]/g, "")) return null;
  return text.length > MAX_SUMMARY_CHARS ? `${text.slice(0, MAX_SUMMARY_CHARS - 1)}…` : text;
}

export function buildApprovalSummaryPrompt(
  req: Pick<PendingApproval, "kind" | "command" | "description">,
  locale: string | null,
): { instructions: string; prompt: string } {
  const instructions = [
    "You explain a pending tool approval to the person who must allow or deny it.",
    `Reply with one short sentence in ${languageName(locale)}: what you are about to do,`,
    "with which tool or server, and whether it only reads or changes something.",
    "Do not quote the command. Do not include file paths, URLs, code, keys or tokens.",
    "Do not call any tools. Reply with the sentence only.",
  ].join(" ");
  const prompt = [
    `Approval type: ${req.kind === "mcp" ? "MCP tool call" : "command"}`,
    `Hermes description: ${req.description}`,
    `Request: ${req.command}`,
  ].join("\n");
  return { instructions, prompt };
}

export type ApprovalSummaryRun = (
  npcId: string,
  input: { instructions: string; prompt: string; sessionKey: string; signal: AbortSignal },
) => Promise<string>;

export function createApprovalSummarizer(deps: {
  run: ApprovalSummaryRun;
  /** The approver's UI language (null when unknown — English). */
  localeOf: (userId: string) => string | null;
  timeoutMs?: number;
}): (req: PendingApproval) => Promise<string | null> {
  const timeoutMs = deps.timeoutMs ?? APPROVAL_SUMMARY_TIMEOUT_MS;
  return async (req) => {
    const { instructions, prompt } = buildApprovalSummaryPrompt(
      req,
      deps.localeOf(req.approverUserId),
    );
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(null);
      }, timeoutMs);
    });
    try {
      const reply = await Promise.race([
        deps.run(req.npcId, {
          instructions,
          prompt,
          sessionKey: `approval-summary-${req.runId}`,
          signal: controller.signal,
        }),
        timedOut,
      ]);
      return reply ? redactApprovalSummary(reply, req.command) : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * The real run: the NPC's own profile, on the stateless runs path so nothing lands in its chat
 * session. This run is not routed through tool approvals — if the model reached for a tool it would
 * wait on nobody, and the timeout above stops it.
 */
export const runApprovalSummaryAsNpc: ApprovalSummaryRun = async (npcId, input) => {
  const client = await getProfileClientForNpc(npcId);
  if (!client) return "";
  let runId: string | null = null;
  const stop = () => {
    if (runId) void client.stopRun(runId).catch(() => {});
  };
  input.signal.addEventListener("abort", stop, { once: true });
  try {
    const { response } = await new HermesAdapter(client).execute({
      sessionKey: input.sessionKey,
      prompt: input.prompt,
      instructions: input.instructions,
      multiParty: true,
      onRunStarted: (id) => {
        runId = id;
        if (input.signal.aborted) stop();
      },
    });
    return response;
  } finally {
    input.signal.removeEventListener("abort", stop);
  }
};
