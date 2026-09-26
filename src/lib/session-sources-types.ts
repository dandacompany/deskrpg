/**
 * What the screen gets for "what did this work read" — client-safe types only (the server side is
 * `session-sources.ts`). Expected states are values, not HTTP errors: a session that Hermes has
 * already deleted, a plugin that cannot answer yet, and work with no session are all normal.
 */
import type { SessionSource } from "@/lib/hermes/deskrpg-plugin-types";

export type SessionSourcesView =
  | { status: "ok"; sources: SessionSource[]; outsideWorkdirFiles: number; truncated: boolean }
  /** Hermes deleted the session after its retention period (ended sessions: 90 days). */
  | { status: "expired" }
  /** The work has no Hermes session to read. */
  | { status: "none" }
  | {
      status: "unavailable";
      reason: "plugin_upgrade_required" | "no_profile_key";
      minVersion?: string;
    };
