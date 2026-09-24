import * as T from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
// Baking a reflection changes winding; keep those meshes under Three's original front-face handling.
function eligibleTransform(object: T.Mesh, root: T.Group, inverse: T.Matrix4) {
  const materials = Array.isArray(object.material) ? object.material : [object.material];
  // Meeting occlusion materials are discarded on restore, so they must not be reused for late asset batching.
  if (materials.some((material) => material.userData.meetingOcclusion)) return false;
  if (new T.Matrix4().multiplyMatrices(inverse, object.matrixWorld).determinant() <= 0)
    return false;
  for (let parent: T.Object3D | null = object; parent && parent !== root; parent = parent.parent)
    if (
      !parent.visible ||
      parent.renderOrder !== 0 ||
      parent.userData.dynamicAsset ||
      parent.userData.meetingWall
    )
      return false;
  return (
    !object.customDepthMaterial &&
    !object.customDistanceMaterial &&
    !Object.hasOwn(object, "onBeforeRender") &&
    !Object.hasOwn(object.material, "onBeforeCompile") &&
    object.geometry.drawRange.start === 0 &&
    object.geometry.drawRange.count === Infinity &&
    Object.keys(object.geometry.morphAttributes).length === 0 &&
    !(object instanceof T.SkinnedMesh)
  );
}
/**
 * Do not bake texture pixels into PNG when building the batching key.
 *
 * `Material.toJSON` serializes the textures it references, and three's `Source.toJSON` encodes a whole base64 PNG
 * via `getDataURL` → `canvas.toDataURL()` when the image is not in meta.
 * All the batching key needs is "do they use the same texture", and the uuid is enough for that.
 *
 * three looks up image entries by the **Source** uuid — putting the image object's uuid there blocks
 * nothing (measurement once led us astray). Register both as empty shells so encoding is skipped.
 */
function stubTextureImages(material: T.Material, resources: T.JSONMeta) {
  for (const value of Object.values(material as unknown as Record<string, unknown>)) {
    if (!(value instanceof T.Texture)) continue;
    for (const uuid of [value.source?.uuid, (value.image as { uuid?: string } | undefined)?.uuid]) {
      if (typeof uuid !== "string") continue;
      resources.images[uuid] ??= { uuid, url: "" };
    }
  }
}

function materialSignatures() {
  const resources: T.JSONMeta = {
    textures: {},
    images: {},
    geometries: {},
    materials: {},
    shapes: {},
    skeletons: {},
    animations: {},
    nodes: {},
  };
  const cache = new WeakMap<T.Material, Map<boolean, string>>();
  return (material: T.Material, colorize = false) => {
    let entries = cache.get(material);
    if (!entries) {
      entries = new Map();
      cache.set(material, entries);
    }
    if (!entries.has(colorize)) {
      // Three's material serializer includes normal/alpha/env maps and physical coating settings.
      // Shared resource metadata avoids serializing the same texture repeatedly.
      stubTextureImages(material, resources);
      const data: Record<string, unknown> = { ...material.toJSON(resources) };
      for (const key of ["uuid", "name", "metadata", "userData"]) delete data[key];
      if (colorize) delete data.color;
      entries.set(colorize, JSON.stringify(data));
    }
    return entries.get(colorize)!;
  };
}
/** Batch opaque static furniture only. Chairs retain individual raycast/seat ownership. */
export function batchStaticFurniture(
  root: T.Group,
  includeDirectChildren = false,
  options: { vertexColors?: boolean; batchSeats?: boolean } = {},
) {
  root.updateMatrixWorld(true);
  const inverse = new T.Matrix4().copy(root.matrixWorld).invert();
  const buckets = new Map<string, T.Mesh<T.BufferGeometry, T.MeshStandardMaterial>[]>();
  const materialKey = materialSignatures();
  root.traverse((object) => {
    if (
      !(object instanceof T.Mesh) ||
      !object.visible ||
      object instanceof T.InstancedMesh ||
      (object.parent === root && !includeDirectChildren) ||
      !(object.material instanceof T.MeshStandardMaterial) ||
      object.material.transparent ||
      !eligibleTransform(object, root, inverse)
    )
      return;
    for (let parent: T.Object3D | null = object; parent && parent !== root; parent = parent.parent)
      if (!options.batchSeats && (parent.userData.seat || parent.userData.seats)) return;
    const m = object.material;
    const key = [
      materialKey(
        m,
        !!options.vertexColors &&
          !object.geometry.hasAttribute("color") &&
          !m.userData.dynamicSurface,
      ),
      !!m.userData.dynamicSurface,
      object.layers.mask,
      object.castShadow,
      object.receiveShadow,
      !!object.geometry.index,
      Object.keys(object.geometry.attributes).sort().join(","),
    ].join("|");
    const bucket = buckets.get(key) ?? [];
    bucket.push(object);
    buckets.set(key, bucket);
  });
  const obsoleteGeometries = new Set<T.BufferGeometry>(),
    obsoleteMaterials = new Set<T.Material>();
  for (const meshes of buckets.values()) {
    if (meshes.length < 2) continue;
    const colorize =
      options.vertexColors &&
      !meshes[0].geometry.hasAttribute("color") &&
      !meshes[0].material.userData.dynamicSurface;
    const transformed = meshes.map((mesh) => {
      const geometry = mesh.geometry
        .clone()
        .applyMatrix4(new T.Matrix4().multiplyMatrices(inverse, mesh.matrixWorld));
      if (colorize) {
        const colors = new Float32Array(geometry.getAttribute("position").count * 3);
        for (let i = 0; i < colors.length; i += 3) mesh.material.color.toArray(colors, i);
        geometry.setAttribute("color", new T.BufferAttribute(colors, 3));
      }
      return geometry;
    });
    const geometry = mergeGeometries(transformed, false);
    transformed.forEach((g) => g.dispose());
    if (!geometry) continue;
    const material = colorize ? meshes[0].material.clone() : meshes[0].material;
    if (colorize) {
      material.color.set(0xffffff);
      material.vertexColors = true;
    }
    const combined = new T.Mesh(geometry, material);
    combined.layers.mask = meshes[0].layers.mask;
    combined.castShadow = meshes[0].castShadow;
    combined.receiveShadow = meshes[0].receiveShadow;
    root.add(combined);
    for (const mesh of meshes) {
      obsoleteGeometries.add(mesh.geometry);
      obsoleteMaterials.add(mesh.material);
      let owner: T.Object3D | null = mesh.parent;
      while (owner && owner !== root && !owner.userData.seat && !owner.userData.seats)
        owner = owner.parent;
      if (options.batchSeats && owner && owner !== root) {
        // Raycaster intentionally visits invisible meshes. Preserve exact geometry and local
        // hierarchy for seat picking, while the merged mesh owns all visible/shadow passes.
        mesh.userData.seatPickProxy = true;
        mesh.visible = false;
        mesh.castShadow = false;
      } else mesh.removeFromParent();
    }
  }
  // Never dispose a resource still referenced by a retained chair or batch.
  root.traverse((o) => {
    if (o instanceof T.Mesh) {
      obsoleteGeometries.delete(o.geometry);
      for (const m of Array.isArray(o.material) ? o.material : [o.material])
        obsoleteMaterials.delete(m);
    }
  });
  obsoleteGeometries.forEach((g) => g.dispose());
  obsoleteMaterials.forEach((m) => m.dispose());
  // Each chair can also batch internally without losing its own seat metadata.
  for (const child of root.children)
    if (
      !options.batchSeats &&
      child instanceof T.Group &&
      (child.userData.seat || child.userData.seats)
    )
      batchStaticFurniture(child, true);
}

/** Merge only parallel, coplanar glazing. Separate wall planes retain transparent sorting. */
export function batchCoplanarGlass(root: T.Group) {
  root.updateMatrixWorld(true);
  const inverse = root.matrixWorld.clone().invert();
  const buckets = new Map<string, T.Mesh<T.BufferGeometry, T.MeshStandardMaterial>[]>();
  const materialKey = materialSignatures();
  root.traverse((object) => {
    if (
      !(object instanceof T.Mesh) ||
      !object.visible ||
      !object.userData.staticGlass ||
      !(object.material instanceof T.MeshStandardMaterial) ||
      !eligibleTransform(object, root, inverse)
    )
      return;
    object.geometry.computeBoundingBox();
    const local = object.geometry.boundingBox!;
    const size = local.getSize(new T.Vector3());
    const normal = new T.Vector3(
      size.x < size.z ? 1 : 0,
      0,
      size.x < size.z ? 0 : 1,
    ).applyNormalMatrix(new T.Matrix3().getNormalMatrix(object.matrixWorld));
    if (normal.x < -1e-8 || (Math.abs(normal.x) < 1e-8 && normal.z < 0)) normal.negate();
    const center = local.getCenter(new T.Vector3()).applyMatrix4(object.matrixWorld);
    const key = [
      normal.x.toFixed(6),
      normal.y.toFixed(6),
      normal.z.toFixed(6),
      normal.dot(center).toFixed(6),
      materialKey(object.material),
      object.layers.mask,
      object.receiveShadow,
      !!object.geometry.index,
      Object.keys(object.geometry.attributes).sort().join(","),
    ].join("|");
    const bucket = buckets.get(key) ?? [];
    bucket.push(object);
    buckets.set(key, bucket);
  });
  const obsoleteGeometry = new Set<T.BufferGeometry>(),
    obsoleteMaterials = new Set<T.Material>();
  for (const meshes of buckets.values()) {
    if (meshes.length < 2) continue;
    const transformed = meshes.map((mesh) =>
      mesh.geometry
        .clone()
        .applyMatrix4(new T.Matrix4().multiplyMatrices(inverse, mesh.matrixWorld)),
    );
    const geometry = mergeGeometries(transformed, false);
    transformed.forEach((part) => part.dispose());
    if (!geometry) continue;
    const batch = new T.Mesh(geometry, meshes[0].material);
    batch.layers.mask = meshes[0].layers.mask;
    batch.castShadow = false;
    batch.receiveShadow = meshes[0].receiveShadow;
    root.add(batch);
    for (const mesh of meshes) {
      obsoleteGeometry.add(mesh.geometry);
      obsoleteMaterials.add(mesh.material);
      mesh.removeFromParent();
    }
  }
  root.traverse((object) => {
    if (!(object instanceof T.Mesh)) return;
    obsoleteGeometry.delete(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material])
      obsoleteMaterials.delete(material);
  });
  obsoleteGeometry.forEach((geometry) => geometry.dispose());
  obsoleteMaterials.forEach((material) => material.dispose());
}
