import type { CharacterAppearance } from "@/game/three/office-appearance";
import { OFFICE_LOOKS, officeLookAppearance, resolveOfficeLook } from "@/game/three/office-looks";

/**
 * Picks a new employee's appearance — **never leaves an employee with no appearance.**
 *
 * If the appearance is empty, the renderer collapses to the default look (`office-jun`),
 * so every employee showed up with the same face. So at registration time, a look no one
 * else on this gateway has used yet is assigned. If all 50 are used, it picks from the
 * whole set even with overlap. Changing it happens on the employee detail screen.
 *
 * @param usedAppearances the `appearance` values of employees on the same gateway (any shape — unrecognized ones are ignored)
 * @param random injected so tests can pin it
 */
export function pickOfficeLookForNewProfile(
  usedAppearances: readonly unknown[],
  random: () => number = Math.random,
): CharacterAppearance {
  const used = new Set(
    usedAppearances.map((value) => resolveOfficeLook(value)?.id).filter(Boolean),
  );
  const unused = OFFICE_LOOKS.filter((look) => !used.has(look.id));
  const pool = unused.length > 0 ? unused : OFFICE_LOOKS;
  const index = Math.min(pool.length - 1, Math.floor(random() * pool.length));
  return officeLookAppearance(pool[index].id);
}
