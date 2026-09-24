/**
 * The mark renderer that runs in the browser. The capture script bundles it with esbuild into a blank page.
 * It uses the same model and lighting as the sidebar headquarters (office-building.ts), so changing the building changes the logo too.
 */
import * as T from "three";

import { addOfficeBuildingLights, buildOfficeBuilding } from "../../src/game/three/office-building";

/** With a background, paint that color (app icon); without, leave it transparent (sidebar mark). */
export function renderBrandMark(size: number, background?: string): string {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const renderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(1);
  renderer.setSize(size, size, false);
  renderer.outputColorSpace = T.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = T.PCFSoftShadowMap;
  const scene = new T.Scene();
  if (background) scene.background = new T.Color(background);
  addOfficeBuildingLights(scene);
  // Drop the trees to narrow the silhouette and fill the frame with the tower so floors and entrance survive at 16px.
  const model = buildOfficeBuilding({ trees: false });
  scene.add(model);
  const box = new T.Box3().setFromObject(model);
  const center = box.getCenter(new T.Vector3());
  const half = Math.max(box.max.x - box.min.x, box.max.y - box.min.y) * 0.62;
  const camera = new T.OrthographicCamera(-half, half, half, -half, 0.1, 40);
  camera.position.set(center.x + 6, center.y + 4.6, center.z + 7);
  camera.lookAt(center.x, center.y - 0.05, center.z);
  camera.updateProjectionMatrix();
  renderer.render(scene, camera);
  return canvas.toDataURL("image/png");
}

declare global {
  interface Window {
    renderBrandMark: typeof renderBrandMark;
  }
}
window.renderBrandMark = renderBrandMark;
