import type { KanbanChannelContext } from "@/lib/kanban-access";

/**
 * R9. Requests a single dispatch right after a card is created or moved into a runnable
 * state. Failure is ignored — it isn't mixed into the response path, and the gateway's
 * built-in dispatcher's next cycle/next poll picks it up. If not called, the card just
 * stays in ready for that one cycle.
 */
export async function dispatchOnce(ctx: Pick<KanbanChannelContext, "client" | "boardSlug">) {
  try {
    await ctx.client.kanban.dispatch(ctx.boardSlug);
  } catch {
    // See the comment above.
  }
}
