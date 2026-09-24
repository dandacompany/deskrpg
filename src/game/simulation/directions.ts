/** Convert between the server wire contract's direction names and the simulation's internal numeric directions. */
export const DIR_UP = 0;
export const DIR_LEFT = 1;
export const DIR_DOWN = 2;
export const DIR_RIGHT = 3;

export const DIR_NAME_MAP: Record<string, number> = {
  up: DIR_UP,
  left: DIR_LEFT,
  down: DIR_DOWN,
  right: DIR_RIGHT,
};
export const DIR_NUM_TO_NAME = ["up", "left", "down", "right"];

export function directionFromName(name: string | undefined): number {
  return DIR_NAME_MAP[name ?? "down"] ?? DIR_DOWN;
}

export function directionName(direction: number): string {
  return DIR_NUM_TO_NAME[direction] ?? "down";
}

/** The direction a movement vector points. Left/right if the horizontal component is larger, otherwise up/down. */
export function directionOfDelta(dx: number, dy: number, horizontalFirst = true): number {
  const horizontal = horizontalFirst ? Math.abs(dx) > Math.abs(dy) : Math.abs(dx) >= Math.abs(dy);
  if (horizontal) return dx > 0 ? DIR_RIGHT : DIR_LEFT;
  return dy > 0 ? DIR_DOWN : DIR_UP;
}
