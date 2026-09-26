/**
 * The swarm root is a **structure card**: Hermes completes it the moment the swarm is created so the workers can
 * start, and keeps it as the shared blackboard. It has no result and no approval policy, so its completion is
 * "the split has started", not finished work — it must not count as throughput or success, and the board shows
 * it as a work split, not as a done task.
 *
 * Both markers are Hermes' own strings (`hermes_cli/kanban_swarm.py`): the activation run's
 * `metadata.kind` and the first sentence of the root's body. Pure — safe for the client bundle.
 */

export const SWARM_ROOT_RUN_KIND = "kanban_swarm_v1";
export const SWARM_ROOT_BODY_PREFIX = "Kanban Swarm v1 planning/root card.";

function metadataOf(run: { metadata?: unknown }): Record<string, unknown> | null {
  let value = run.metadata;
  if (typeof value === "string") {
    // The timeline route passes the sqlite column through, so metadata can arrive as its JSON text.
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The run Hermes synthesizes when it completes a swarm root. */
export function isSwarmStructureRun(run: { metadata?: unknown }): boolean {
  return metadataOf(run)?.kind === SWARM_ROOT_RUN_KIND;
}

/** A swarm root card, recognized by the body Hermes writes for it. */
export function isSwarmStructureCard(task: { body?: string | null }): boolean {
  return typeof task.body === "string" && task.body.startsWith(SWARM_ROOT_BODY_PREFIX);
}
