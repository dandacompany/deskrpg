import type { ToolApprovalChoice } from "./tool-approval-types";

export type ParsedApprovalEvent = {
  runId: string;
  requestId: string | null;
  command: string;
  description: string;
  kind: "mcp" | "command";
  /** Hermes' `pattern_key` (which rule flagged it) — groups repeats of the same request. */
  patternKey: string | null;
  choices: ToolApprovalChoice[];
};

const OFFERED = ["once", "session", "deny"] as const;

/**
 * Parses the `data` of an SSE `approval.request` (shape measured on staging, spec appendix A).
 * `always` is dropped: permanent approval is never offered from DeskRPG. Returns null without a
 * run id — nothing could resolve it.
 */
export function parseApprovalEvent(data: Record<string, unknown>): ParsedApprovalEvent | null {
  const runId = typeof data.run_id === "string" && data.run_id ? data.run_id : null;
  if (!runId) return null;
  const raw = Array.isArray(data.choices) ? data.choices : ["once", "deny"];
  const choices = OFFERED.filter((c) => raw.includes(c));
  return {
    runId,
    requestId: typeof data.request_id === "string" && data.request_id ? data.request_id : null,
    command: typeof data.command === "string" ? data.command.slice(0, 500) : "",
    description: typeof data.description === "string" ? data.description.slice(0, 500) : "",
    kind: data.pattern_key === "mcp_elicitation" ? "mcp" : "command",
    patternKey:
      typeof data.pattern_key === "string" && data.pattern_key
        ? data.pattern_key.slice(0, 200)
        : null,
    choices: choices.length ? [...choices] : ["once", "deny"],
  };
}
