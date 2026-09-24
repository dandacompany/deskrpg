import { LERP_FACTOR } from "./constants";

export interface RemotePlayerData {
  id: string;
  userId?: string;
  characterName: string;
  appearance: unknown;
  x: number;
  y: number;
  direction: string;
  animation: string;
}

/** A remote player. Holds display coordinates (x, y) interpolated every frame toward the server snapshot coordinates (target). */
export class RemotePlayer {
  readonly id: string;
  userId?: string;
  name: string;
  appearance: unknown;
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  direction: string;
  animation: string;

  constructor(data: RemotePlayerData) {
    this.id = data.id;
    this.userId = data.userId;
    this.name = data.characterName;
    this.appearance = data.appearance;
    this.x = this.targetX = data.x;
    this.y = this.targetY = data.y;
    this.direction = data.direction || "down";
    this.animation = data.animation || "idle";
  }

  updatePosition(x: number, y: number, direction: string, animation: string): void {
    this.targetX = x;
    this.targetY = y;
    this.direction = direction;
    this.animation = animation;
  }

  /** Snap when close, teleport when too far (over 200px), fixed-ratio interpolation in between. */
  lerpUpdate(): void {
    const dx = this.targetX - this.x;
    const dy = this.targetY - this.y;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
      this.x = this.targetX;
      this.y = this.targetY;
    } else if (Math.abs(dx) > 200 || Math.abs(dy) > 200) {
      this.x = this.targetX;
      this.y = this.targetY;
    } else {
      this.x += dx * LERP_FACTOR;
      this.y += dy * LERP_FACTOR;
    }
  }

  distanceTo(x: number, y: number): number {
    return Math.hypot(this.x - x, this.y - y);
  }
}
