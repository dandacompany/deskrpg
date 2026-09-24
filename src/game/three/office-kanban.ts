import * as T from "three";
import type { MapSnapshot } from "./bridge";
import { findPath } from "../navigation";
import { round } from "./primitives";

/** The office bulletin board: only the finish differs per map, while approach, selection and arrival behavior are shared. */
export const OFFICE_BOARD_STYLES = {
  agency: { x: 26, frame: "#b39a73", panel: "#d4bd8d", accent: "#cd785b" },
  publishing: { x: 24, frame: "#977348", panel: "#ddd2b3", accent: "#788668" },
  tech: { x: 30, frame: "#384751", panel: "#e2eaeb", accent: "#5485a2" },
  trading: { x: 15, frame: "#655846", panel: "#e3ded0", accent: "#46657b" },
  executive: { x: 4, frame: "#806039", panel: "#54483d", accent: "#baa276" },
} as const;
export function boardLocation(map: MapSnapshot) {
  const style = OFFICE_BOARD_STYLES[map.environment as keyof typeof OFFICE_BOARD_STYLES];
  if (!style) return null;
  return {
    x: Math.min(map.cols - 3, style.x),
    z: map.environment === "agency" ? 0.4 : 0.68,
    style,
  };
}
export function boardApproach(
  map: MapSnapshot,
  player: { x: number; y: number },
  walkable: (x: number, y: number) => boolean,
) {
  const board = boardLocation(map);
  if (!board) return null;
  const sx = Math.floor(player.x),
    sy = Math.floor(player.y);
  const candidates: { x: number; y: number }[] = [];
  for (let y = 1; y <= 4; y++)
    for (let x = Math.floor(board.x) - 2; x <= Math.floor(board.x) + 2; x++)
      if (walkable(x, y)) candidates.push({ x, y });
  candidates.sort(
    (a, b) =>
      Math.hypot(a.x + 0.5 - board.x, a.y + 0.5 - board.z) -
      Math.hypot(b.x + 0.5 - board.x, b.y + 0.5 - board.z),
  );
  return candidates.find((p) => findPath(sx, sy, p.x, p.y, walkable)) ?? null;
}
export function buildOfficeBoard(map: MapSnapshot) {
  const location = boardLocation(map);
  if (!location) return null;
  const { x, z, style } = location;
  const g = new T.Group();
  g.name = "office-kanban-board";
  g.position.set(x, 1.85, z);
  g.userData.dynamicAsset = true;
  round(g, 3.8, 1.85, 0.12, style.frame, 0, 0, 0, 0.035);
  round(g, 3.6, 1.65, 0.03, style.panel, 0, 0, 0.078, 0.012);
  for (let col = 0; col < 3; col++) {
    round(g, 0.95, 0.08, 0.016, style.accent, (col - 1) * 1.13, 0.6, 0.105, 0.005);
    for (let row = 0; row < 2; row++) {
      round(
        g,
        0.87,
        0.45,
        0.018,
        row === 0 ? "#faf4df" : "#e3e5d8",
        (col - 1) * 1.13,
        0.22 - row * 0.56,
        0.112,
        0.006,
      );
      for (let line = 0; line < 3; line++)
        round(
          g,
          0.57 - line * 0.08,
          0.013,
          0.008,
          style.accent,
          (col - 1) * 1.13 - 0.05,
          0.29 - row * 0.56 - line * 0.085,
          0.126,
          0.002,
        );
    }
  }
  return g;
}
/** Cancelled on re-command, map swap or timeout, and run only once after actual arrival. */
export class BoardArrival {
  private pending: { x: number; y: number; expires: number } | null = null;
  start(x: number, y: number, now: number) {
    this.pending = { x, y, expires: now + 60000 };
  }
  cancel() {
    this.pending = null;
  }
  update(player: { x: number; y: number; walking: boolean } | undefined, now: number) {
    const p = this.pending;
    if (!p) return false;
    if (now > p.expires) {
      this.cancel();
      return false;
    }
    if (player && !player.walking && Math.hypot(player.x - p.x, player.y - p.y) < 0.6) {
      this.cancel();
      return true;
    }
    return false;
  }
}
