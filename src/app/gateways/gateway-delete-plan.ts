/** What the gateway's profiles bring along. `sumGatewayUsage` totals it. */
export type GatewayUsage = { profiles: number; npcs: number; channels: number };

/**
 * Decides what to ask before showing the delete confirmation.
 *
 * The server (`api/gateways/[id]` DELETE) **refuses** with 409 `gateway_in_use_by_channels` if there is even one
 * channel binding. Still asking "프로필과 NPC 자리가 함께 사라집니다" would let the user agree to a deletion that will not
 * happen and then see a screen where nothing happened — exactly the kind of false confirmation this task set out
 * to remove.
 *
 * So if even one seat is out in a channel, the confirmation is not shown at all, and the user is told to
 * unbind first.
 */
export function planGatewayDelete(
  usage: GatewayUsage,
): { blocked: true } | { blocked: false; profiles: number; npcs: number } {
  if (usage.channels > 0) return { blocked: true };
  return { blocked: false, profiles: usage.profiles, npcs: usage.npcs };
}
