import * as T from "three";
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from "three-mesh-bvh";

/**
 * Accelerate raycasts with a BVH.
 *
 * This scene has 799 meshes and 906,164 triangles, and the largest mesh batching produced has 80k triangles (measured:
 * production build, trading office 44×30). three's default raycast sweeps all those triangles, so
 * one world raycast took about 100ms — just moving the mouse gave 10fps.
 *
 * `acceleratedRaycast` falls back to three's default path as is when there is no `geometry.boundsTree`.
 * Only geometry with a built tree gets faster; everything else behaves the same.
 */
let installed = false;
function installRaycastAcceleration() {
  if (installed) return;
  installed = true;
  const geometry = T.BufferGeometry.prototype as unknown as Record<string, unknown>;
  geometry.computeBoundsTree = computeBoundsTree;
  geometry.disposeBoundsTree = disposeBoundsTree;
  (T.Mesh.prototype as unknown as Record<string, unknown>).raycast = acceleratedRaycast;
}

/** The size at which building a tree pays off. For small meshes building costs more. */
const MIN_TRIANGLES_FOR_BVH = 600;

export function buildBoundsTrees(root: T.Object3D) {
  installRaycastAcceleration();
  root.traverse((object) => {
    if (!(object instanceof T.Mesh)) return;
    const geometry = object.geometry as T.BufferGeometry & {
      boundsTree?: unknown;
      computeBoundsTree?: () => void;
    };
    if (geometry.boundsTree || !geometry.computeBoundsTree) return;
    const index = geometry.getIndex();
    const triangles = (index ? index.count : (geometry.getAttribute("position")?.count ?? 0)) / 3;
    if (triangles < MIN_TRIANGLES_FOR_BVH) return;
    geometry.computeBoundsTree();
  });
}
