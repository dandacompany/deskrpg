/** Render clouds in the browser and return a PNG data URL (the capture script bundles this with esbuild). */
import * as T from "three";

import { addCloudLights, buildCloud } from "../../src/game/three/sky-clouds";

export function renderCloud(variant: 0 | 1 | 2, width: number, height: number): string {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const renderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);
  renderer.outputColorSpace = T.SRGBColorSpace;
  const scene = new T.Scene();
  addCloudLights(scene);
  const cloud = buildCloud(variant);
  scene.add(cloud);
  const box = new T.Box3().setFromObject(cloud);
  const center = box.getCenter(new T.Vector3());
  // Fit both width and height — fitting only the width crops the top and bottom (2026-09-20 measurement).
  const aspect = width / height;
  let halfWidth = (box.max.x - box.min.x) / 2 + 0.25;
  let halfHeight = (box.max.y - box.min.y) / 2 + 0.25;
  if (halfWidth / halfHeight < aspect) halfWidth = halfHeight * aspect;
  else halfHeight = halfWidth / aspect;
  const camera = new T.OrthographicCamera(-halfWidth, halfWidth, halfHeight, -halfHeight, 0.1, 40);
  camera.position.set(center.x, center.y, center.z + 12);
  camera.lookAt(center);
  camera.updateProjectionMatrix();
  renderer.render(scene, camera);
  return canvas.toDataURL("image/png");
}

declare global {
  interface Window {
    renderCloud: typeof renderCloud;
  }
}
window.renderCloud = renderCloud;
