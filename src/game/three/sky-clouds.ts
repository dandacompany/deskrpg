/**
 * Morning sky clouds — the miniature clouds used by the commute screen (`/auth`).
 *
 * Same approach as the sidebar headquarters: built with three.js, baked once and used as a PNG
 * (`scripts/sky/render-clouds.ts`). Clouds made from CSS shapes showed two overlapping ellipses
 * and were called "shape-like" (2026-09-20). Several spheres are overlapped to make a cumulus silhouette.
 */
import * as T from "three";

export type CloudPuff = { x: number; y: number; z: number; r: number };

/** The same cloud comes from a seed — no random numbers, so the screen and the script do not drift apart. */
export function cloudPuffs(variant: 0 | 1 | 2): CloudPuff[] {
  const shapes: CloudPuff[][] = [
    [
      { x: -1.55, y: -0.12, z: 0, r: 0.62 },
      { x: -0.75, y: 0.2, z: 0.15, r: 0.86 },
      { x: 0.1, y: 0.34, z: -0.1, r: 1.02 },
      { x: 0.95, y: 0.12, z: 0.12, r: 0.78 },
      { x: 1.68, y: -0.16, z: -0.05, r: 0.56 },
      { x: -0.35, y: -0.42, z: 0.25, r: 0.66 },
      { x: 0.62, y: -0.4, z: -0.22, r: 0.6 },
    ],
    [
      { x: -1.2, y: -0.1, z: 0.1, r: 0.54 },
      { x: -0.45, y: 0.26, z: -0.12, r: 0.82 },
      { x: 0.35, y: 0.1, z: 0.18, r: 0.7 },
      { x: 1.05, y: -0.18, z: -0.08, r: 0.5 },
      { x: -0.1, y: -0.38, z: 0.2, r: 0.58 },
    ],
    [
      { x: -1.8, y: -0.2, z: 0.05, r: 0.5 },
      { x: -1.0, y: 0.08, z: -0.14, r: 0.72 },
      { x: -0.2, y: 0.42, z: 0.1, r: 0.9 },
      { x: 0.7, y: 0.22, z: -0.18, r: 0.8 },
      { x: 1.5, y: -0.05, z: 0.16, r: 0.64 },
      { x: 2.1, y: -0.28, z: -0.06, r: 0.44 },
      { x: 0.2, y: -0.46, z: 0.22, r: 0.7 },
    ],
  ];
  return shapes[variant];
}

/** One cloud. The top is white in the sunlight and the bottom sinks slightly (sky-blue reflection). */
export function buildCloud(variant: 0 | 1 | 2): T.Group {
  const group = new T.Group();
  // Keep the shading range narrow so lump boundaries do not stand out — high contrast looks like "balls glued together",
  // and removing it entirely (emissive) turns the cloud into a white plate. Only the bottom sinks slightly with sky blue.
  const material = new T.MeshStandardMaterial({ color: "#fdfefe", roughness: 1, metalness: 0 });
  for (const puff of cloudPuffs(variant)) {
    const mesh = new T.Mesh(new T.SphereGeometry(puff.r, 32, 24), material);
    mesh.position.set(puff.x, puff.y, puff.z);
    // Cumulus clouds are squashed vertically — perfect spheres look like cotton candy.
    mesh.scale.set(1, 0.82, 0.94);
    group.add(mesh);
  }
  return group;
}

/** Cloud-only lighting — white from above, sky blue from below. Not mixed with the headquarters lighting. */
export function addCloudLights(scene: T.Scene) {
  scene.add(new T.HemisphereLight("#ffffff", "#dce7f1", 3.1));
  const sun = new T.DirectionalLight("#fff6e0", 0.55);
  sun.position.set(2.5, 4, 3);
  scene.add(sun);
  return sun;
}
