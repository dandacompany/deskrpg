import * as T from "three";
import type { OfficeLook } from "./office-looks";
import { createActor, cylinder } from "./characters";
import { disposeTree } from "./office-renderer";
import { captureWhenReady } from "./ready-capture";

/**
 * Camera framing for the portrait (round avatar). Square output, framed so that, seen slightly from the front above the neck,
 * it includes from the top of the head (including high buns and curls) down to both shoulders. Characters are GLB actors
 * normalized to about 1.9–1.93m from the floor origin (see the `commute-walk.ts` comment).
 * `office-look-thumbnail.test.ts` pins the coverage with these constants.
 */
export const PORTRAIT_FRAMING = {
  fov: 20,
  position: new T.Vector3(0.35, 1.82, 1.75),
  target: new T.Vector3(0, 1.68, 0),
} as const;

type SceneSetup = {
  scene: T.Scene;
  actor: ReturnType<typeof createActor>;
  release: () => void;
};

/** Gallery lights + pedestal + actor setup, shared by the full-body and portrait captures. */
function setupScene(look: OfficeLook, index: number, withPedestal: boolean): SceneSetup {
  const scene = new T.Scene();
  let disposed = false;
  const release = () => {
    if (disposed) return;
    disposed = true;
    disposeTree(scene);
  };
  scene.add(new T.HemisphereLight("#fff8ed", "#89988b", 2.5));
  const light = new T.DirectionalLight("#fff1dc", 3);
  light.position.set(-2, 4, 4);
  scene.add(light);
  if (withPedestal) cylinder(scene, 0.46, 0.5, 0.06, "#d9cbb6", 0, 0.015, 0);
  const actor = createActor(look.id, look.coat, index, undefined, look);
  scene.add(actor.root);
  return { scene, actor, release };
}

/** Full-body look-gallery capture (unchanged framing: 240x280, pedestal, front-ish 3/4 view). */
export async function captureThumbnail(
  renderer: T.WebGLRenderer,
  look: OfficeLook,
  index: number,
  signal: AbortSignal,
) {
  const { scene, actor, release } = setupScene(look, index, true);
  try {
    const camera = new T.PerspectiveCamera(30, 240 / 280, 0.1, 20);
    camera.position.set(1.5, 1.8, 4.2);
    camera.lookAt(0, 0.97, 0);
    return await captureWhenReady(
      "ready" in actor ? actor.ready : Promise.resolve(true),
      signal,
      () => {
        actor.update(0, false, "idle", false);
        renderer.render(scene, camera);
        return renderer.domElement.toDataURL("image/png");
      },
      release,
    );
  } finally {
    release();
  }
}

/** Face-and-shoulders portrait for round roster avatars: no pedestal, square aspect. */
export async function capturePortrait(
  renderer: T.WebGLRenderer,
  look: OfficeLook,
  signal: AbortSignal,
) {
  const { scene, actor, release } = setupScene(look, 0, false);
  try {
    const camera = new T.PerspectiveCamera(PORTRAIT_FRAMING.fov, 1, 0.1, 20);
    camera.position.copy(PORTRAIT_FRAMING.position);
    camera.lookAt(PORTRAIT_FRAMING.target);
    return await captureWhenReady(
      "ready" in actor ? actor.ready : Promise.resolve(true),
      signal,
      () => {
        actor.update(0, false, "idle", false);
        renderer.render(scene, camera);
        return renderer.domElement.toDataURL("image/png");
      },
      release,
    );
  } finally {
    release();
  }
}
