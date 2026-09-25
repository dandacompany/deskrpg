export type AgentProgressPhase = "idle" | "connecting" | "done" | "failed";

export function getAgentProgressMeter(phase: AgentProgressPhase): {
  className: string;
  width: string;
} {
  switch (phase) {
    case "done":
      return { className: "bg-success", width: "100%" };
    case "failed":
      return { className: "bg-danger", width: "100%" };
    case "connecting":
      return { className: "bg-info animate-pulse", width: "33%" };
    default:
      return { className: "bg-info animate-pulse", width: "10%" };
  }
}
