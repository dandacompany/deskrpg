export type GameNotification = {
  id: string;
  message: string;
  timestamp: number;
  read: boolean;
};

/**
 * Adds a notice to the top of the list. Several events reuse a fixed id (a dropped socket, an
 * occupied tile), so a repeat replaces the earlier entry instead of stacking a duplicate — the
 * ids are the list's React keys.
 */
export function pushNotification(
  prev: GameNotification[],
  next: GameNotification,
  cap = 20,
): GameNotification[] {
  return [next, ...prev.filter((n) => n.id !== next.id)].slice(0, cap);
}
