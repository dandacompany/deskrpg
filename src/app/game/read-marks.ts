/**
 * When the viewer counts as having read a conversation. Pure so `node:test` can pin it; the page
 * wires it to the chat panel's visibility and the browser tab's visibility.
 */

/** Looking at `id` means the panel shows it and the browser tab is in front. */
export function isLookingAt(
  visibleId: string | null,
  id: string,
  pageVisible: boolean = typeof document === "undefined" || document.visibilityState === "visible",
): boolean {
  return pageVisible && visibleId === id;
}

/** Something in this conversation is newer than the viewer's read point. */
export function needsReadMark(conversation: {
  unread?: number;
  lastAt?: string | null;
  readAt?: string | null;
}): boolean {
  if ((conversation.unread ?? 0) > 0) return true;
  if (!conversation.lastAt || !conversation.readAt) return false;
  return new Date(conversation.lastAt).getTime() > new Date(conversation.readAt).getTime();
}
