import { clearSegment, type NavigationPoint, type Walkable } from "../navigation";
import { createAmbientSchedule, type AmbientSchedule } from "../npc-ambient";
import type { AmbientExitPolicy } from "../ambient-zones";
import type { RemoteNpcPresentation } from "../remote-npc-presentation";
import { TILE_SIZE } from "./constants";
import { DIR_DOWN, DIR_LEFT, DIR_RIGHT, DIR_UP, directionFromName } from "./directions";
import { DEFAULT_NPC_MOTION } from "../../lib/npc-motion-config";

export interface NpcData {
  id: string;
  name: string;
  positionX: number;
  positionY: number;
  direction: string;
  appearance?: unknown;
}

export type NpcPathfinder = (
  sx: number,
  sy: number,
  ex: number,
  ey: number,
  walkable: Walkable,
) => NavigationPoint[] | null;

export type NpcMoveState = "idle" | "moving-to-player" | "waiting" | "returning" | "strolling";

/**
 * The README capture must fit the meeting scene into 9 seconds, but at normal walking speed gathering alone takes 16 seconds
 * (measured 2026-09-20). Walking is sped up only in the capture runtime — the service values stay as they are.
 */
export const CAPTURE_WALK_MULTIPLIER = 3;
export function captureWalkSpeed(speed: number): number {
  return process.env.NEXT_PUBLIC_README_CAPTURE === "1" ? speed * CAPTURE_WALK_MULTIPLIER : speed;
}

/**
 * The movement state machine for one NPC. There are no screen elements — `pixelX/pixelY` are the collision/authoritative coordinates,
 * and `viewX/viewY` are the display coordinates sent to the renderer (remote-driven NPCs have a separate interpolated display following).
 */
export class NpcController {
  appearance: unknown;
  id: string;
  name: string;
  pixelX: number;
  pixelY: number;
  viewX: number;
  viewY: number;
  direction: number;

  // Movement state (runtime only, not persisted)
  homeCol: number;
  homeRow: number;
  homeDirection: number;
  currentPath: NavigationPoint[] | null = null;
  pathIndex = 0;
  private trafficBlockedMs = 0;
  actuallyWalking = false;
  moveState: NpcMoveState = "idle";
  destinationTag: string | null = null;
  destinationTarget: NavigationPoint | null = null;
  purposeAccessOrigin: NavigationPoint | null = null;
  ambientPaused = false;
  ambientTimer = 0;
  ambientSchedule: AmbientSchedule = createAmbientSchedule();
  ambientSeat: { x: number; y: number } | null = null;
  ambientExitPolicy: AmbientExitPolicy | null = null;
  remoteWalkingUntil = 0;
  remotePresentation: RemoteNpcPresentation | null = null;
  motionLocallyDriven?: boolean;
  /** Normal move (return, approaching to talk) speed, px/s. Overridden by the channel's walking setting (`npc-motion-config`). */
  moveSpeed = DEFAULT_NPC_MOTION.walk;
  /** Stroll speed, px/s. */
  strollSpeed = DEFAULT_NPC_MOTION.stroll;
  /**
   * The speed of the path being walked now. Set by moves that use a different speed per path, like calls and meeting calls.
   * `null` means the default for the state (`strollSpeed` when strolling, `moveSpeed` otherwise).
   */
  pathSpeed: number | null = null;
  pendingMessage: string | null = null;
  arrivalBubbleText: string | null = null;
  waitDurationMs = 10000;
  /** Which room called — null means called directly. A roomId like "r1" means called from a room, so they do not go back to their seat while that room is visible. */
  calledForRoom: string | null = null;
  private pathRecalcTimer = 0; // accumulated ms
  private stuckFrames = 0;
  private lastDist = Infinity;
  waitTimer = 0; // ms accumulated in the "waiting" state

  constructor(data: NpcData) {
    this.id = data.id;
    this.appearance = data.appearance;
    this.name = data.name;
    this.pixelX = data.positionX * TILE_SIZE + TILE_SIZE / 2;
    this.pixelY = data.positionY * TILE_SIZE + TILE_SIZE / 2;
    this.viewX = this.pixelX;
    this.viewY = this.pixelY;
    this.direction = directionFromName(data.direction);
    this.homeCol = data.positionX;
    this.homeRow = data.positionY;
    this.homeDirection = this.direction;
  }

  /** Move the authoritative coordinates into the display coordinates. Locally driven moves call this every frame. */
  syncView(): void {
    this.viewX = this.pixelX;
    this.viewY = this.pixelY;
  }

  /** Move the authoritative and display coordinates together (snap). */
  setPosition(x: number, y: number): void {
    this.pixelX = x;
    this.pixelY = y;
    this.syncView();
  }

  distanceTo(x: number, y: number): number {
    return Math.hypot(this.pixelX - x, this.pixelY - y);
  }

  updateName(name: string): void {
    this.name = name;
  }

  updateDirection(direction: string): void {
    this.homeDirection = directionFromName(direction);
    this.direction = this.homeDirection;
    this.stopWalking();
  }

  updateAppearance(appearance: unknown): void {
    if (!appearance) return;
    this.appearance = appearance;
  }

  updateFromData(data: { name?: string; direction?: string; appearance?: unknown }): void {
    if (typeof data.name === "string" && data.name.trim()) this.updateName(data.name);
    if (typeof data.direction === "string") this.updateDirection(data.direction);
    if (data.appearance !== undefined) this.updateAppearance(data.appearance);
  }

  moveTo(
    targetCol: number,
    targetRow: number,
    findPathFn: NpcPathfinder,
    isWalkableFn: Walkable,
    options?: {
      message?: string;
      bubbleText?: string;
      waitDurationMs?: number;
      destinationTag?: string;
      /** The speed (px/s) of this move. A call comes running — different from the usual walk. */
      speed?: number;
    },
  ): boolean {
    const startCol = Math.floor(this.pixelX / TILE_SIZE);
    const startRow = Math.floor(this.pixelY / TILE_SIZE);

    // Path straight to the player's tile — arrival is judged by NPC_INTERACT_RADIUS, so they
    // stop before actually overlapping.
    const path = findPathFn(startCol, startRow, targetCol, targetRow, isWalkableFn);
    if (!path || path.length === 0) return false;

    this.currentPath = path;
    this.pathIndex = 0;
    this.stuckFrames = 0;
    this.lastDist = Infinity;
    this.pathRecalcTimer = 0;
    this.pendingMessage = options?.message || null;
    this.arrivalBubbleText = options?.bubbleText || null;
    this.waitDurationMs = options?.waitDurationMs ?? 10000;
    this.pathSpeed = options?.speed ?? null;
    this.destinationTag = options?.destinationTag ?? null;
    this.destinationTarget = this.destinationTag ? { x: targetCol, y: targetRow } : null;
    this.purposeAccessOrigin = this.destinationTag ? { x: startCol, y: startRow } : null;
    this.moveState = "moving-to-player";
    return true;
  }

  /** The current walking speed (px/s). In the README capture runtime a multiplier applies. */
  currentSpeed(): number {
    const base =
      this.pathSpeed ?? (this.moveState === "strolling" ? this.strollSpeed : this.moveSpeed);
    return captureWalkSpeed(base);
  }

  /** If `speed` is given, walk at that speed instead of the stroll speed — meeting gathering uses this path. */
  startStroll(path: NavigationPoint[], speed?: number): void {
    this.pathSpeed = speed ?? null;
    this.destinationTag = null;
    this.destinationTarget = null;
    this.purposeAccessOrigin = null;
    this.currentPath = path;
    this.pathIndex = 0;
    this.stuckFrames = 0;
    this.lastDist = Infinity;
    this.moveState = "strolling";
  }

  stopStroll(): void {
    if (this.moveState !== "strolling") return;
    this.currentPath = null;
    this.moveState = "idle";
    this.stopWalking();
  }

  cancelMovement(): void {
    this.currentPath = null;
    this.moveState = "idle";
    this.ambientPaused = false;
    this.remoteWalkingUntil = 0;
    this.pendingMessage = null;
    this.destinationTag = null;
    this.destinationTarget = null;
    this.purposeAccessOrigin = null;
    this.stopWalking();
  }

  returnToHome(findPathFn: NpcPathfinder, isWalkableFn: Walkable): boolean {
    this.calledForRoom = null;
    this.destinationTag = null;
    this.destinationTarget = null;
    this.purposeAccessOrigin = null;
    this.ambientTimer = 0;
    const startCol = Math.floor(this.pixelX / TILE_SIZE);
    const startRow = Math.floor(this.pixelY / TILE_SIZE);

    if (
      Math.hypot(
        this.pixelX - (this.homeCol + 0.5) * TILE_SIZE,
        this.pixelY - (this.homeRow + 0.5) * TILE_SIZE,
      ) < 2
    ) {
      this.moveState = "idle";
      this.snapToHome();
      return true;
    }

    // Even if the seat is blocked or cut off, the return stays in the waiting state — no teleporting through walls.
    this.currentPath = findPathFn(startCol, startRow, this.homeCol, this.homeRow, isWalkableFn);
    this.pathIndex = 0;
    this.stuckFrames = 0;
    this.lastDist = Infinity;
    this.pathRecalcTimer = 0;
    this.pendingMessage = null;
    this.arrivalBubbleText = null;
    this.waitDurationMs = 10000;
    this.pathSpeed = null;
    this.moveState = "returning";
    return true;
  }

  private snapToHome(): void {
    this.pixelX = this.homeCol * TILE_SIZE + TILE_SIZE / 2;
    this.pixelY = this.homeRow * TILE_SIZE + TILE_SIZE / 2;
    this.direction = this.homeDirection;
    this.syncView();
    this.stopWalking();
  }

  pauseForSmalltalk(other: NpcController): void {
    // Keep the path and goal so the same stroll continues after the conversation ends.
    if (this.moveState === "strolling") {
      const dx = other.pixelX - this.pixelX,
        dy = other.pixelY - this.pixelY;
      this.direction =
        Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? DIR_RIGHT : DIR_LEFT) : dy > 0 ? DIR_DOWN : DIR_UP;
    }
    this.stopWalking();
  }

  private stopWalking(): void {
    this.actuallyWalking = false;
  }

  updateMovement(
    delta: number,
    playerX: number,
    playerY: number,
    findPathFn: NpcPathfinder,
    isWalkableFn: Walkable,
    trafficStep?: (
      position: NavigationPoint,
      goal: NavigationPoint,
      amount: number,
    ) => NavigationPoint,
  ): "arrived" | "returning-done" | "moving" | "idle" {
    this.actuallyWalking = false;
    if (this.moveState === "idle" || this.moveState === "waiting") return "idle";
    if (!this.currentPath) {
      this.pathRecalcTimer += Math.min(delta, 100);
      if (this.pathRecalcTimer < 1000) return "idle";
      this.pathRecalcTimer = 0;
      const targetX =
        this.moveState === "returning"
          ? this.homeCol
          : (this.destinationTarget?.x ?? Math.floor(playerX / TILE_SIZE));
      const targetY =
        this.moveState === "returning"
          ? this.homeRow
          : (this.destinationTarget?.y ?? Math.floor(playerY / TILE_SIZE));
      const path = findPathFn(
        Math.floor(this.pixelX / TILE_SIZE),
        Math.floor(this.pixelY / TILE_SIZE),
        targetX,
        targetY,
        isWalkableFn,
      );
      if (!path) return "idle";
      this.currentPath = path;
      this.pathIndex = 0;
      this.stuckFrames = 0;
      this.lastDist = Infinity;
    }

    // --- Path recomputation (every 3 seconds, only while heading to the player) ---
    if (this.moveState === "moving-to-player" && !this.destinationTag) {
      this.pathRecalcTimer += delta;
      if (this.pathRecalcTimer >= 3000) {
        this.pathRecalcTimer = 0;
        const distToPlayer = this.distanceTo(playerX, playerY);
        if (distToPlayer > TILE_SIZE + 4) {
          const playerCol = Math.floor(playerX / TILE_SIZE);
          const playerRow = Math.floor(playerY / TILE_SIZE);
          const startCol = Math.floor(this.pixelX / TILE_SIZE);
          const startRow = Math.floor(this.pixelY / TILE_SIZE);
          const newPath = findPathFn(startCol, startRow, playerCol, playerRow, isWalkableFn);
          if (newPath && newPath.length > 0) {
            this.currentPath = newPath;
            this.pathIndex = 0;
            this.stuckFrames = 0;
            this.lastDist = Infinity;
          }
        }
      }

      // --- Arrival check — within interaction distance (one tile) ---
      const distToPlayer = this.distanceTo(playerX, playerY);
      if (distToPlayer < TILE_SIZE + 4) {
        // ~36px — right next to the player
        this.currentPath = null;
        this.moveState = "waiting";
        const adx = playerX - this.pixelX;
        const ady = playerY - this.pixelY;
        if (Math.abs(adx) > Math.abs(ady)) {
          this.direction = adx > 0 ? DIR_RIGHT : DIR_LEFT;
        } else {
          this.direction = ady > 0 ? DIR_DOWN : DIR_UP;
        }
        this.stopWalking();
        this.waitTimer = 0;
        return "arrived";
      }
    }

    // --- Path exhaustion check ---
    if (this.pathIndex >= this.currentPath.length) {
      if (this.moveState === "strolling") {
        this.stopStroll();
        return "idle";
      }
      if (this.moveState === "returning") {
        // The path ended — attach to the spot regardless of distance
        this.snapToHome();
        this.currentPath = null;
        this.moveState = "idle";
        return "returning-done";
      }
      if (this.destinationTag) return this.finishDestinationMove();
      // Heading to the player, but the path ended before reaching them — wait for recomputation
      this.currentPath = null;
      return "moving";
    }

    // --- Path following (same approach as the player) ---
    const target = this.currentPath[this.pathIndex];
    if (this.moveState === "strolling" && !isWalkableFn(target.x, target.y)) {
      this.stopStroll();
      return "idle";
    }
    const targetPx = target.x * TILE_SIZE + TILE_SIZE / 2;
    const targetPy = target.y * TILE_SIZE + TILE_SIZE / 2;

    const dx = targetPx - this.pixelX;
    const dy = targetPy - this.pixelY;
    const dist = Math.hypot(dx, dy);

    // Stuck detection (same as the player)
    if (dist < this.lastDist - 0.5) {
      this.stuckFrames = 0;
      this.lastDist = dist;
    } else {
      this.stuckFrames++;
    }

    const reached = dist < 2;
    const stuck = !trafficStep && this.stuckFrames > 30;

    if (stuck && !reached) {
      if (this.moveState === "strolling") {
        this.stopStroll();
        return "idle";
      }
      this.currentPath = null;
      this.pathRecalcTimer = 0;
      this.stopWalking();
      return "moving";
    }
    if (reached) {
      // On to the next waypoint (no snap — same as the player)
      this.pathIndex++;
      this.stuckFrames = 0;
      this.lastDist = Infinity;

      if (this.pathIndex >= this.currentPath.length) {
        if (this.moveState === "strolling") {
          this.stopStroll();
          return "idle";
        }
        if (this.moveState === "returning") {
          this.snapToHome();
          this.currentPath = null;
          this.moveState = "idle";
          this.stopWalking();
          return "returning-done";
        }
        if (this.destinationTag) return this.finishDestinationMove();
        // The path to the player ended — wait for the next recompute cycle
        this.currentPath = null;
        this.stopWalking();
        return "moving";
      }
    }

    // Always move toward the current waypoint (velocity-based)
    const curTarget = this.currentPath[this.pathIndex];
    const curPx = curTarget.x * TILE_SIZE + TILE_SIZE / 2;
    const curPy = curTarget.y * TILE_SIZE + TILE_SIZE / 2;
    const cdx = curPx - this.pixelX;
    const cdy = curPy - this.pixelY;

    const moveAmount = Math.min(
      Math.hypot(cdx, cdy),
      this.currentSpeed() * (Math.min(delta, 100) / 1000),
    );
    const angle = Math.atan2(cdy, cdx);
    const planned = trafficStep?.(
      { x: this.pixelX / TILE_SIZE - 0.5, y: this.pixelY / TILE_SIZE - 0.5 },
      curTarget,
      moveAmount / TILE_SIZE,
    );
    const nextX = planned
      ? (planned.x + 0.5) * TILE_SIZE
      : this.pixelX + Math.cos(angle) * moveAmount;
    const nextY = planned
      ? (planned.y + 0.5) * TILE_SIZE
      : this.pixelY + Math.sin(angle) * moveAmount;
    if (
      !clearSegment(
        { x: this.pixelX / TILE_SIZE - 0.5, y: this.pixelY / TILE_SIZE - 0.5 },
        { x: nextX / TILE_SIZE - 0.5, y: nextY / TILE_SIZE - 0.5 },
        isWalkableFn,
      )
    ) {
      if (this.moveState === "strolling") {
        this.stopStroll();
        return "idle";
      }
      this.currentPath = null;
      this.pathRecalcTimer = 0;
      this.stopWalking();
      return "moving";
    }
    if (Math.hypot(nextX - this.pixelX, nextY - this.pixelY) < 1e-6) {
      this.trafficBlockedMs += Math.min(delta, 100);
      // A stopped actor can occupy an intermediate waypoint forever. Traffic coordination cannot reach
      // that waypoint, so recompute the whole path to the destination and detour.
      if (this.trafficBlockedMs >= 1500) {
        // Even without a detour, keep the stroll or seat destination. Clearing the stroll path would
        // wrongly drop into the player target.
        const destination = this.currentPath[this.currentPath.length - 1];
        const detour =
          destination &&
          findPathFn(
            Math.floor(this.pixelX / TILE_SIZE),
            Math.floor(this.pixelY / TILE_SIZE),
            destination.x,
            destination.y,
            isWalkableFn,
          );
        if (detour?.length) {
          this.currentPath = detour;
          this.pathIndex = 0;
          this.stuckFrames = 0;
          this.lastDist = Infinity;
        }
        this.trafficBlockedMs = 0;
      }
      this.stopWalking();
      return "moving";
    }
    this.trafficBlockedMs = 0;
    this.actuallyWalking = true;
    const actualDx = nextX - this.pixelX,
      actualDy = nextY - this.pixelY;
    this.pixelX = nextX;
    this.pixelY = nextY;

    // Yielding can move in a direction other than the original waypoint — look at the actual movement direction.
    if (Math.abs(actualDx) > Math.abs(actualDy)) {
      this.direction = actualDx > 0 ? DIR_RIGHT : DIR_LEFT;
    } else {
      this.direction = actualDy > 0 ? DIR_DOWN : DIR_UP;
    }

    this.syncView();
    return "moving";
  }

  private finishDestinationMove(): "arrived" {
    this.currentPath = null;
    this.moveState = "waiting";
    this.waitTimer = 0;
    this.destinationTag = null;
    this.destinationTarget = null;
    this.purposeAccessOrigin = null;
    this.stopWalking();
    return "arrived";
  }
}
