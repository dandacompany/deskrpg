export type AgentProgressPhase = "idle" | "connecting" | "done" | "failed";

export function getAgentProgressMeter(phase: AgentProgressPhase): {
  className: string;
  width: string;
} {
  switch (phase) {
    case "done":
      return { className: "bg-green-500", width: "100%" };
    case "failed":
      return { className: "bg-red-500", width: "100%" };
    case "connecting":
      return { className: "bg-indigo-500 animate-pulse", width: "33%" };
    default:
      return { className: "bg-indigo-500 animate-pulse", width: "10%" };
  }
}
