export const CITYSCAPE_WALKER_MIN_SPEED = 0.65;
export const CITYSCAPE_WALKER_MAX_SPEED = 1.05;
export const CITYSCAPE_WALKER_FRAME_INTERVAL = 8;

export function createWalkerSpeed(randomValue: number): number {
  const clamped = Math.max(0, Math.min(1, randomValue));
  const speedRange = CITYSCAPE_WALKER_MAX_SPEED - CITYSCAPE_WALKER_MIN_SPEED;
  return Number((CITYSCAPE_WALKER_MIN_SPEED + clamped * speedRange).toFixed(2));
}

export function shouldAdvanceWalkerFrame(frameCount: number): boolean {
  return frameCount % CITYSCAPE_WALKER_FRAME_INTERVAL === 0;
}
