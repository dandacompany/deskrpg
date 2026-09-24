import { EXECUTIVE_LOUNGE_RUG } from "./executive-lounge-layout";
import { executiveSurface } from "./executive-surfaces";
import { attachFurnitureAsset, attachSceneAsset } from "./furniture-asset";
import * as T from "three";
import { round } from "./primitives";
import { surfaceTexture } from "./surface-detail";
import { EXECUTIVE_ZONES } from "./executive-room-layout";

/** Normal mode keeps the fixed shell; occlusion of the returned walls is handled only in meeting mode. */
export function addExecutiveArchitecture(root: T.Group, cols: number, rows: number) {
  const walls: T.Object3D[] = [];
  const wood = executiveSurface(root, "walnut");
  const brass = new T.MeshStandardMaterial({ color: "#b49355", metalness: 0.75, roughness: 0.3 });
  const stone = executiveSurface(root, "limestone");
  const frame = new T.MeshStandardMaterial({ color: "#454039", metalness: 0.55, roughness: 0.4 });
  const light = new T.MeshStandardMaterial({
    color: "#fff0c8",
    emissive: "#ffce7b",
    emissiveIntensity: 1.5,
  });
  const box = (w: number, h: number, d: number, m: T.Material, x: number, y: number, z: number) =>
    round(root, w, h, d, m, x, y, z, 0.025);
  const wallBox: typeof box = (...args) => {
    const wall = box(...args);
    walls.push(wall);
    return wall;
  };
  // Large honed limestone tiles with subtle, deterministic mineral veins.
  for (let z = 0; z < rows; z += 2)
    for (let x = 0; x < cols; x += 2) {
      box(1.992, 0.035, 1.992, stone, x + 1, 0.012, z + 1);
    }
  for (const zone of EXECUTIVE_ZONES.filter((z) => z.id !== "meeting")) {
    const rug = new T.MeshStandardMaterial({
      color: zone.color,
      map: surfaceTexture("fabric", "color"),
      roughness: 1,
    });
    const asset = new T.Group();
    asset.position.set(zone.x + zone.width / 2, 0.035, zone.z + zone.depth / 2);
    asset.scale.set((zone.width - 1) / 5.9, 1, (zone.depth - 1) / 5.9);
    if (zone.id === "pantry") {
      asset.position.set(EXECUTIVE_LOUNGE_RUG.x, 0.035, EXECUTIVE_LOUNGE_RUG.z);
      asset.scale.set(EXECUTIVE_LOUNGE_RUG.width / 5.9, 1, EXECUTIVE_LOUNGE_RUG.depth / 5.9);
    }
    round(asset, 5.9, 0.026, 5.9, rug, 0, 0.013, 0);
    root.add(asset);
    void attachFurnitureAsset(asset, "rug");
  }

  // Continuous walnut side walls, recessed flutes and a single dark top rail.
  for (const x of [0.5, cols - 0.5]) {
    wallBox(0.32, 3.8, rows - 1, wood, x, 1.9, rows / 2);
    wallBox(0.42, 0.13, rows - 0.8, frame, x, 3.84, rows / 2);
    wallBox(0.4, 0.22, rows - 1, frame, x, 0.11, rows / 2);
    for (let z = 1; z < rows - 1; z += 0.38)
      wallBox(0.025, 3.55, 0.025, frame, x + (x < 1 ? 0.17 : -0.17), 1.9, z);
    for (const y of [0.28, 3.58])
      wallBox(0.025, 0.018, rows - 1, brass, x + (x < 1 ? 0.18 : -0.18), y, rows / 2);
    for (const z of [3, 9, rows - 3]) {
      const inside = x + (x < 1 ? 0.25 : -0.25);
      wallBox(0.13, 1.25, 0.14, brass, inside, 2.2, z);
      wallBox(0.15, 1.02, 0.07, light, inside + (x < 1 ? 0.08 : -0.08), 2.2, z);
    }
    // Framed abstract diptych: geometry instead of externally licensed artwork.
    const inside = x + (x < 1 ? 0.21 : -0.21);
    wallBox(0.08, 1.85, 2.5, brass, inside, 2.1, 8);
    wallBox(0.1, 1.7, 2.35, stone, inside + (x < 1 ? 0.04 : -0.04), 2.1, 8);
    for (let i = 0; i < 3; i++)
      wallBox(
        0.12,
        0.55 + i * 0.23,
        0.42,
        frame,
        inside + (x < 1 ? 0.07 : -0.07),
        2,
        7.35 + i * 0.62,
      );
  }
  wallBox(cols - 1, 0.16, 0.4, frame, cols / 2, 3.84, 0.5);
  wallBox(cols - 1, 0.35, 0.4, wood, cols / 2, 0.18, 0.5);
  const glass = new T.MeshStandardMaterial({
    color: "#c6d6dd",
    transparent: true,
    opacity: 0.22,
    depthWrite: false,
    roughness: 0.2,
  });
  for (let x = 1; x < cols - 1; x += 2) {
    wallBox(0.08, 3.6, 0.15, frame, x, 2, 0.5);
    const pane = wallBox(1.9, 3.4, 0.025, glass, x + 1, 2, 0.5);
    pane.castShadow = false;
  }
  // Low front glazing keeps entry and occupants legible at the default camera angle.
  for (const [start, end] of [
    [0.5, Math.floor(cols / 2) - 1],
    [Math.floor(cols / 2) + 2, cols - 0.5],
  ]) {
    wallBox(end - start, 0.07, 0.1, brass, (start + end) / 2, 0.95, rows - 0.5);
    wallBox(end - start, 0.85, 0.025, glass, (start + end) / 2, 0.48, rows - 0.5).castShadow =
      false;
    for (const x of [start, end]) wallBox(0.14, 1.02, 0.16, brass, x, 0.51, rows - 0.5);
  }
  // Common backdrop assets stay outside navigation. Two depth layers avoid a flat skyline.
  for (let i = 0; i < 8; i++) {
    const tower = new T.Group();
    tower.position.set(1 + (i * (cols - 2)) / 7, -2.4, i % 2 ? -7.5 : -5);
    tower.scale.set(1, 0.75 + ((i * 7) % 5) * 0.085, 1);
    root.add(tower);
    void attachSceneAsset(tower, i % 3 ? "glass-tower" : "stone-tower");
  }
  // Pavement and a planted verge anchor the avenue below the office windows.
  box(cols - 1, 0.12, 2.1, stone, cols / 2, -1.3, -2.2);
  for (let i = 0; i < 6; i++) {
    const tree = new T.Group();
    tree.position.set(1.2 + (i * (cols - 2.4)) / 5, -1.25, -2.4);
    tree.rotation.y = i * 2.399;
    tree.scale.setScalar(0.68 + (i % 3) * 0.055);
    root.add(tree);
    void attachSceneAsset(tree, "street-tree");
  }
  return walls;
}
