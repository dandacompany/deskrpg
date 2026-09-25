import type { McpServerView, McpTool } from "@/lib/hermes/plugin-client-types";

/** What DeskRPG can observe about a server — Hermes Desktop's seven card states, collapsed (spec §5.1). */
export type CardState = "connected" | "checking" | "needsAuth" | "error" | "off" | "unchecked";

export type QuickAction = "all" | "noDestructive" | "readOnly";

const AUTH_RE = /\b(401|403)\b|unauthori[sz]ed|forbidden|invalid[_ ]token|needs? auth|oauth/i;

export function isAuthError(text: string): boolean {
  return AUTH_RE.test(text);
}

export function cardState(s: McpServerView, busy: boolean): CardState {
  if (!s.enabled) return "off";
  if (busy) return "checking";
  if (s.auth === "oauth" && !s.oauthTokenPresent) return "needsAuth";
  if (s.secrets.some((x) => !x.hasValue)) return "needsAuth";
  if (!s.lastCheck) return "unchecked";
  if (s.lastCheck.ok) return "connected";
  return isAuthError(s.lastCheck.error ?? "") ? "needsAuth" : "error";
}

/**
 * The include list for a quick action. Hermes only honours `readOnlyHint === true` as
 * read-only; `destructiveHint` is advisory, so "no destructive" keeps unannotated tools.
 */
export function quickAction(tools: McpTool[], action: QuickAction): { include: string[] } {
  const pick = tools.filter((t) =>
    action === "all"
      ? true
      : action === "readOnly"
        ? t.readOnlyHint === true
        : t.destructiveHint !== true,
  );
  return { include: pick.map((t) => t.name) };
}

/** Enabled servers never checked or last checked more than `maxAgeMs` ago — re-checked when the manager opens. */
export function staleServers(servers: McpServerView[], now: number, maxAgeMs = 300_000): string[] {
  return servers
    .filter((s) => s.enabled && (!s.lastCheck || now - Date.parse(s.lastCheck.at) > maxAgeMs))
    .map((s) => s.name);
}
