import { captureStudioLabelOccluders } from "./studio-visibility";
import * as T from "three";
import {
  attachSceneAsset,
  sceneAsset,
  type SceneAssetId,
  type SceneAssetLoader,
} from "./scene-asset-catalog";
import { batchCoplanarGlass, batchStaticFurniture } from "./static-batching";
import { CREATIVE_STUDIO_FINISH } from "./office-finishes";
import {
  CREATIVE_STUDIO_DIRECTOR_BOUNDARY,
  CREATIVE_STUDIO_MEETING_BOUNDARY,
} from "./creative-studio-layout";
import { CREATIVE_STUDIO_ENTRANCE } from "./office-environments";
import { surfaceTexture } from "./surface-detail";

/** Capability gate also protects edited/unmigrated v2 agency maps. */
export function isCreativeStudioMap(map: {
  environment?: string;
  environmentVersion?: number;
  cols: number;
  rows: number;
}) {
  return (
    map.environment === "agency" &&
    (map.environmentVersion ?? 0) >= 3 &&
    map.cols === 42 &&
    map.rows === 26
  );
}

type SurfaceName = "oak" | "brick" | "plaster";
type TextureLoad = (url: string) => Promise<T.Texture>;
export function creativeStudioSurface(
  host: T.Group,
  surface: SurfaceName,
  options: { repeat?: readonly [number, number]; load?: TextureLoad } = {},
) {
  const material = new T.MeshStandardMaterial({
    color: { oak: "#d9c5a3", brick: "#a45f43", plaster: "#e5e0d3" }[surface],
    roughness: surface === "oak" ? 0.52 : 0.85,
  });
  material.userData.dynamicSurface = true;
  // Valid deterministic grain remains visible if the authored maps are unavailable.
  if (surface === "oak") {
    material.bumpMap = surfaceTexture("wood");
    material.bumpScale = 0.008;
  }
  const status = new T.Group();
  status.userData.dynamicAsset = true;
  status.userData.assetStatus = "loading";
  host.add(status);
  let disposed = false;
  // Attached textures belong to disposeTree; only in-flight arrivals are freed here.
  material.addEventListener("dispose", () => {
    disposed = true;
  });
  const load = options.load ?? ((url: string) => new T.TextureLoader().loadAsync(url));
  status.userData.sceneAssetUrls = ["color", "normal", "roughness"].map(
    (kind) => `/assets/shared/surfaces/${surface}-${kind}.webp`,
  );
  status.userData.assetReady = Promise.allSettled(
    ["color", "normal", "roughness"].map(async (kind) => {
      const texture = await load(`/assets/shared/surfaces/${surface}-${kind}.webp`);
      if (disposed) {
        texture.dispose();
        return;
      }
      texture.colorSpace = kind === "color" ? T.SRGBColorSpace : T.NoColorSpace;
      texture.wrapS = texture.wrapT = T.RepeatWrapping;
      texture.repeat.set(...(options.repeat ?? [1, 1]));
      texture.anisotropy = 8;
      if (kind === "color") {
        material.map = texture;
        material.color.set("#ffffff");
      }
      if (kind === "normal") {
        material.normalMap = texture;
        material.normalScale.setScalar(0.28);
      }
      if (kind === "roughness") {
        material.roughnessMap = texture;
        material.roughness = 1;
      }
      material.needsUpdate = true;
    }),
  ).then((results) => {
    status.userData.assetStatus = disposed
      ? "disposed"
      : results.every((r) => r.status === "fulfilled")
        ? "ready"
        : "failed";
  });
  return material;
}

/** Reference angle only changes the overview preset. Orbit/pan/zoom remain native. */
export function creativeStudioOverview(
  cols: number,
  rows: number,
  aspect: number,
  fovDegrees = 38,
) {
  // A foreground ground-plane pivot balances perspective foreshortening: the
  // old geometric-center target left a large empty upper half of the frame.
  const target = new T.Vector3(cols / 2, 1.2, rows / 2).addScaledVector(
    new T.Vector3(0.72, 0, 1).normalize(),
    Math.hypot(cols, rows) * 0.16,
  );
  const direction = new T.Vector3(0.72, 0.65, 1).normalize();
  const right = new T.Vector3().crossVectors(new T.Vector3(0, 1, 0), direction).normalize();
  const up = new T.Vector3().crossVectors(direction, right);
  const vertical = Math.tan(T.MathUtils.degToRad(fovDegrees / 2));
  const horizontal = vertical * Math.max(0.1, aspect);
  let distance = 0;
  for (const x of [-0.2, cols + 0.2])
    for (const y of [-0.5, 4.2])
      for (const z of [-0.2, rows + 0.2]) {
        const point = new T.Vector3(x, y, z).sub(target);
        distance = Math.max(
          distance,
          point.dot(direction) +
            Math.max(Math.abs(point.dot(right)) / horizontal, Math.abs(point.dot(up)) / vertical) /
              0.9,
        );
      }
  return { target, position: target.clone().addScaledVector(direction, distance), distance };
}

/** Alternating window/pier spans partition the perimeter without holes or overlaps. */
export function studioPerimeterBays(length: number) {
  const bays: { kind: "pier" | "window"; start: number; end: number; head: number }[] = [];
  const add = (kind: "pier" | "window", start: number, end: number) => {
    const last = bays.at(-1);
    if (last?.kind === kind && last.end === start) last.end = end;
    else bays.push({ kind, start, end, head: 3.6 });
  };
  add("pier", 0, 1);
  let cursor = 1;
  while (cursor < length - 1) {
    const end = Math.min(cursor + 5, length - 1);
    add("window", cursor, end);
    cursor = end;
    if (cursor < length - 1) {
      add("pier", cursor, cursor + 1);
      cursor++;
    }
  }
  add("pier", length - 1, length);
  return bays;
}

/** Environment adapter: modules are reusable; only this shell knows studio coordinates. */
export function addCreativeStudioArchitecture(
  root: T.Group,
  cols: number,
  rows: number,
  options: {
    load?: SceneAssetLoader;
    loadTexture?: TextureLoad;
    includeDirectorSuite?: boolean;
  } = {},
) {
  if (cols !== 42 || rows !== 26)
    throw Error("Creative studio architecture requires 42 × 26 tiles");
  const shell = new T.Group();
  shell.name = "creative-studio-architecture";
  const meetingWalls: T.Object3D[] = [];
  shell.userData.meetingWalls = meetingWalls;
  const wallPlanes = new Map<string, T.Group>();
  // Isolate asynchronous ownership from outer scene batches. Local batches ignore their root's flag.
  shell.userData.dynamicAsset = true;
  shell.userData.assetStatus = "loading";
  root.add(shell);
  let disposed = false;
  shell.userData.disposeActor = () => {
    disposed = true;
  };
  const pending: Promise<unknown>[] = [];
  const steel = new T.MeshStandardMaterial({ color: "#343d3a", metalness: 0.65, roughness: 0.36 });
  const glass = new T.MeshStandardMaterial({
    color: "#cbdcdb",
    opacity: 0.18,
    transparent: true,
    depthWrite: false,
    roughness: 0.16,
    metalness: 0.08,
    side: T.DoubleSide,
  });
  function box(
    owner: T.Group,
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    material: T.Material,
  ) {
    const mesh = new T.Mesh(new T.BoxGeometry(w, h, d), material);
    mesh.position.set(x, y, z);
    mesh.castShadow = !material.transparent;
    mesh.receiveShadow = true;
    if (material.transparent) mesh.userData.staticGlass = true;
    owner.add(mesh);
    return mesh;
  }
  const oak = creativeStudioSurface(shell, "oak", {
    repeat: [cols / 3, rows / 2],
    load: options.loadTexture,
  });
  const brick = new T.MeshStandardMaterial({ color: "#a66449", roughness: 0.87 });
  const plaster = new T.MeshStandardMaterial({ color: "#e5dfd2", roughness: 0.86 });
  const timber = new T.MeshStandardMaterial({ color: "#c9ab7d", roughness: 0.58 });
  const floor = box(shell, cols, 0.035, rows, cols / 2, 0.0175, rows / 2, oak);
  floor.name = "continuous-pale-oak-floor";
  floor.castShadow = false;
  // UVs on a box top have unit scale, so one texture repeat spans a consistent 3 x 2 meters.
  function module(
    id: SceneAssetId,
    x: number,
    y: number,
    z: number,
    scale: readonly [number, number, number] = [1, 1, 1],
    rotation = 0,
    name?: string,
  ) {
    const asset = sceneAsset(id);
    const host = new T.Group();
    host.name = name ?? id;
    // The plinth is floor finish; only wall modules are kept as meeting occlusion targets.
    host.position.set(x, y, z);
    host.scale.set(...scale);
    host.rotation.y = rotation;
    if (id !== "shared-cutaway-plinth") {
      // Continuous walls are batched only within the same plane. Door leaves are occluded/restored independently.
      const vertical = Math.abs(Math.sin(rotation)) > 0.5;
      const key = /door|entrance/.test(id)
        ? `door:${host.uuid}`
        : `${vertical ? "x" : "z"}:${(vertical ? x : z).toFixed(4)}`;
      let plane = wallPlanes.get(key);
      if (!plane) {
        plane = new T.Group();
        plane.name = `meeting-wall-plane:${key}`;
        plane.userData.meetingWall = true;
        wallPlanes.set(key, plane);
        meetingWalls.push(plane);
        shell.add(plane);
      }
      plane.add(host);
    } else shell.add(host);
    const [min, max] = [asset.bounds.min, asset.bounds.max];
    const w = max[0] - min[0],
      h = max[1] - min[1],
      d = max[2] - min[2];
    if (asset.tags.includes("glass")) {
      box(host, w - 0.12, h - 0.12, 0.012, 0, h / 2, 0, glass);
      for (const xx of [-w / 2 + 0.035, w / 2 - 0.035])
        box(host, 0.07, h, 0.1, xx, h / 2, 0, steel);
      for (const yy of [0.035, h - 0.035]) box(host, w, 0.07, 0.1, 0, yy, 0, steel);
      if (id === "shared-grid-window") {
        for (const xx of [-w / 6, w / 6]) box(host, 0.035, h - 0.1, 0.07, xx, h / 2, 0, steel);
        box(host, w, 0.04, 0.07, 0, h * 0.54, 0, steel);
      }
      if (id === "shared-double-entrance") box(host, 0.055, h, 0.1, 0, h / 2, 0, steel);
    } else
      box(
        host,
        w,
        h,
        d,
        0,
        h / 2,
        0,
        id === "shared-brick-panel" ? brick : id === "shared-plaster-panel" ? plaster : timber,
      );
    pending.push(
      attachSceneAsset(host, id, { load: options.load, normalScale: 0.28, anisotropy: 8 }).then(
        (ready) => {
          if (disposed) return;
          host.updateWorldMatrix(true, true);
          const inverseShell = shell.matrixWorld.clone().invert();
          host.traverse((object) => {
            if (!(object instanceof T.Mesh)) return;
            const materials = Array.isArray(object.material) ? object.material : [object.material];
            // Snap UVs to shell meters after scaling modules. A low brick sill must have
            // the same course height as the adjacent full-height pier, not squeezed courses.
            if (materials.length === 1 && ["oak", "brick", "plaster"].includes(materials[0].name)) {
              const transform = new T.Matrix4().multiplyMatrices(inverseShell, object.matrixWorld);
              const normalMatrix = new T.Matrix3().getNormalMatrix(transform);
              const positions = object.geometry.getAttribute("position");
              const normals = object.geometry.getAttribute("normal");
              const uv = object.geometry.getAttribute("uv");
              const point = new T.Vector3(),
                normal = new T.Vector3();
              if (uv && normals)
                for (let i = 0; i < positions.count; i++) {
                  point.fromBufferAttribute(positions, i).applyMatrix4(transform);
                  normal.fromBufferAttribute(normals, i).applyNormalMatrix(normalMatrix);
                  const isTop =
                    Math.abs(normal.y) > Math.max(Math.abs(normal.x), Math.abs(normal.z));
                  const isSide = Math.abs(normal.x) > Math.abs(normal.z);
                  uv.setXY(
                    i,
                    (isTop ? point.x : isSide ? point.z : point.x) /
                      (materials[0].name === "oak" ? 3 : 2),
                    (isTop ? point.z : point.y) / 2,
                  );
                }
              if (uv) uv.needsUpdate = true;
            }
            if (materials.some((m) => m.transparent)) {
              object.castShadow = false;
              object.userData.staticGlass = true;
              for (const m of materials) if (m.transparent) m.depthWrite = false;
            }
          });
          // Both ready and failed fallback hosts now have stable geometry; permit shell-local batching.
          delete host.userData.dynamicAsset;
          return ready;
        },
      ),
    );
    return host;
  }
  // Shared head height and exact endpoint partitioning close the defining high corner.
  for (let x = 1; x < cols; x += 2) module("shared-brick-panel", x, 0, 0.14, [1, 0.25, 1]);
  for (const bay of studioPerimeterBays(cols)) {
    const width = bay.end - bay.start;
    module(
      bay.kind === "window" ? "shared-grid-window" : "shared-brick-panel",
      (bay.start + bay.end) / 2,
      bay.kind === "window" ? 0.9 : 0,
      0.14,
      bay.kind === "window" ? [width / 4, (bay.head - 0.9) / 2.5, 1] : [width / 2, 1, 1],
    );
  }
  for (let z = 1; z < rows; z += 2)
    module("shared-plaster-panel", 0.14, 0, z, [1, 0.25, 1], Math.PI / 2);
  for (const bay of studioPerimeterBays(rows)) {
    const width = bay.end - bay.start;
    module(
      bay.kind === "window" ? "shared-grid-window" : "shared-brick-panel",
      0.14,
      bay.kind === "window" ? 0.9 : 0,
      (bay.start + bay.end) / 2,
      bay.kind === "window" ? [width / 4, (bay.head - 0.9) / 2.5, 1] : [width / 2, 1, 1],
      Math.PI / 2,
    );
  }
  box(shell, cols, 0.1, 0.26, cols / 2, 3.65, 0.14, steel).name = "rear-continuous-top-rail";
  box(shell, 0.26, 0.1, rows, 0.14, 3.65, rows / 2, steel).name = "left-continuous-top-rail";
  // Front/right cutaway rails stay low so the work and lounge zones remain visible.
  const entryStart = CREATIVE_STUDIO_ENTRANCE.fromCol;
  const entryEnd = CREATIVE_STUDIO_ENTRANCE.toCol + 1;
  for (const [start, end] of [
    [0, entryStart],
    [entryEnd, cols],
  ] as const) {
    module("shared-cutaway-plinth", (start + end) / 2, -0.32, rows, [(end - start) / 3, 1, 1]);
    for (let x = start; x < end; x += 2)
      module("shared-glass-partition", x + Math.min(2, end - x) / 2, 0, rows, [
        Math.min(2, end - x) / 2,
        0.28,
        1,
      ]);
  }
  module(
    "shared-double-entrance",
    (entryStart + entryEnd) / 2,
    0,
    rows,
    [(entryEnd - entryStart) / 4, 1, 1],
    0,
    "centered-double-entrance",
  );
  module("shared-cutaway-plinth", cols, -0.32, rows / 2, [rows / 3, 1, 1], Math.PI / 2);
  module("shared-cutaway-plinth", 0, -0.32, rows / 2, [rows / 3, 1, 1], Math.PI / 2);
  module("shared-cutaway-plinth", cols / 2, -0.32, 0, [cols / 3, 1, 1]);
  for (let z = 10.5; z < rows; z += 2)
    module(
      "shared-glass-partition",
      cols,
      0,
      z + Math.min(2, rows - z) / 2,
      [Math.min(2, rows - z) / 2, 0.28, 1],
      Math.PI / 2,
    );
  const meeting = CREATIVE_STUDIO_MEETING_BOUNDARY;
  const west = meeting.westCol + 0.5,
    east = meeting.eastCol + 0.88;
  const front = meeting.frontRow + 0.5;
  // Row0 already belongs to the rear collision boundary; row1 now closes the old gap.
  // The solid span reaches the rear glazing and leaves exactly rows8–9 open.
  for (const [start, end] of [
    [0.26, 2],
    [2, 4],
    [4, 6],
    [6, 8],
    [10, front],
  ] as const)
    module(
      "shared-glass-partition",
      west,
      0,
      (start + end) / 2,
      [(end - start) / 2, 1, 1],
      Math.PI / 2,
    );
  for (let start = west; start < east; start += 2) {
    const end = Math.min(start + 2, east);
    module("shared-glass-partition", (start + end) / 2, 0, front, [(end - start) / 2, 1, 1]);
  }
  // 180-degree inward fold about the row8 jamb. The 0.33m offset allows the
  // complete leaf/frame/handle thickness to clear the fixed glazing, inside tile32.
  const hingeX = meeting.westCol + 0.83,
    hingeZ = meeting.doorRows[0] - 0.03;
  module("shared-glass-door", hingeX, 0, hingeZ - 1, [1, 1, 1], Math.PI / 2, "meeting-open-door");
  for (const y of [0.3, 2.9]) box(shell, 0.31, 0.045, 0.045, west + 0.19, y, hingeZ, steel);
  module(
    "shared-plaster-panel",
    east,
    0,
    (0.14 + front) / 2,
    [(front - 0.14) / 2, 1, 1],
    Math.PI / 2,
  );
  // Continuous head ties west, door opening and front glass into a joined enclosure.
  box(shell, 0.1, 0.1, front - 0.14, west, 3.65, (front + 0.14) / 2, steel);
  box(shell, east - west, 0.1, 0.1, (east + west) / 2, 3.65, front, steel);
  // Photo boundary matches authoritative three solid glass_partition tiles.
  for (const row of [5, 6, 7])
    module("shared-glass-partition", 9.5, 0, row + 0.5, [0.5, 0.85, 1], Math.PI / 2);
  const director = CREATIVE_STUDIO_DIRECTOR_BOUNDARY;
  if (options.includeDirectorSuite !== false) {
    for (let start = director.northCols[0]; start <= director.northCols.at(-1)!; start += 2) {
      const end = Math.min(start + 2, director.northCols.at(-1)! + 1);
      module("shared-glass-partition", (start + end) / 2, 0, director.northRow + 0.5, [
        (end - start) / 2,
        0.9,
        1,
      ]);
      module("shared-glass-partition", (start + end) / 2, 0, director.southRow + 0.5, [
        (end - start) / 2,
        0.9,
        1,
      ]);
    }
    for (const [start, end] of [
      [director.northRow, director.doorRows[0]],
      [director.doorRows[1] + 1, director.southRow + 1],
    ] as const)
      module(
        "shared-glass-partition",
        director.eastCol + 0.5,
        0,
        (start + end) / 2,
        [(end - start) / 2, 0.9, 1],
        Math.PI / 2,
      );
    module(
      "shared-glass-door",
      director.eastCol + 0.82,
      0,
      director.doorRows[0] - 1.03,
      [1, 1, 1],
      Math.PI / 2,
      "director-open-door",
    );
  }
  // Coral backing sits above the pantry's existing counter footprint, never on its approach aisle.
  const coral = new T.MeshStandardMaterial({
    color: CREATIVE_STUDIO_FINISH.accent,
    roughness: 0.83,
  });
  const feature = new T.Group();
  feature.name = "pantry-coral-feature-wall";
  feature.userData.meetingWall = true;
  meetingWalls.push(feature);
  shell.add(feature);
  box(feature, 4, 2.4, 0.1, 39, 1.2, front + 0.12, coral);
  const glow = new T.MeshStandardMaterial({
    color: "#fff0d3",
    emissive: "#ffd49b",
    emissiveIntensity: 0.65,
    roughness: 0.6,
  });
  box(shell, 3.8, 0.025, 0.045, 39, 2.25, front + 0.2, glow).name = "pantry-warm-task-strip";
  pending.push(
    ...shell.children
      .filter((o) => o.userData.assetReady && !o.userData.disposeActor)
      .map((o) => o.userData.assetReady),
  );
  shell.userData.assetReady = Promise.all(pending).then(() => {
    if (disposed) return false;
    // The loader clones GPU ownership per host. Consolidate identical, explicitly declared
    // architectural slots inside this disposable shell before batching, so their texture
    // UUIDs do not split a repeated wall into dozens of material buckets.
    const declared = new Set(Object.values(sceneAsset("shared-brick-panel").materialSlots ?? {}));
    const materials = new Map<string, T.Material>();
    const retired = new Set<T.Material>();
    shell.traverse((object) => {
      if (!(object instanceof T.Mesh)) return;
      const reuse = (material: T.Material) => {
        if (!declared.has(material.name) || !(material instanceof T.MeshStandardMaterial))
          return material;
        const key = `${material.name}:${material.color.getHexString()}`;
        const shared = materials.get(key);
        if (!shared) {
          materials.set(key, material);
          return material;
        }
        if (shared !== material) retired.add(material);
        return shared;
      };
      object.material = Array.isArray(object.material)
        ? object.material.map(reuse)
        : reuse(object.material);
    });
    const keptTextures = new Set<T.Texture>();
    for (const material of materials.values())
      for (const value of Object.values(material))
        if (value instanceof T.Texture) keptTextures.add(value);
    const retiredTextures = new Set<T.Texture>();
    for (const material of retired) {
      for (const value of Object.values(material))
        if (value instanceof T.Texture && !keptTextures.has(value)) retiredTextures.add(value);
      material.dispose();
    }
    retiredTextures.forEach((texture) => texture.dispose());
    shell.userData.studioLabelOccluders = captureStudioLabelOccluders(shell);
    for (const plane of wallPlanes.values()) {
      batchCoplanarGlass(plane);
      batchStaticFurniture(plane, true);
    }
    batchCoplanarGlass(shell);
    batchStaticFurniture(shell, true);
    shell.userData.assetStatus = "ready";
    return true;
  });
  return shell;
}
