import * as T from "three";
import { round } from "./primitives";
import { officeRoomsForSurface, type OfficeRoomSurfaceContext } from "./office-room-layout";
import { batchStaticFurniture } from "./static-batching";
import { roomLabel } from "./room-labels";
export function addRoomPartition(parent: T.Group, vertical: boolean, length = 1): T.Group {
  const width = vertical ? 0.14 : length,
    depth = vertical ? length : 0.14;
  round(parent, width, 0.055, depth, "#435454", 0, 0.0275, 0, 0.01);

  const upper = new T.Group();
  parent.add(upper);
  const pane = new T.Mesh(
    new T.BoxGeometry(vertical ? 0.035 : length - 0.05, 1.69, vertical ? length - 0.05 : 0.035),
    new T.MeshStandardMaterial({
      color: "#b9d2ce",
      roughness: 0.25,
      metalness: 0.05,
      transparent: true,
      opacity: 0.14,
      depthWrite: false,
    }),
  );
  pane.userData.staticGlass = true;
  pane.position.y = 0.925;
  upper.add(pane);
  round(upper, width, 0.055, depth, "#435454", 0, 1.8, 0, 0.008);
  round(
    upper,
    vertical ? 0.15 : 0.045,
    1.75,
    vertical ? 0.045 : 0.15,
    "#435454",
    vertical ? 0 : -length / 2 + 0.023,
    0.925,
    vertical ? -length / 2 + 0.023 : 0,
    0.008,
  );
  round(
    upper,
    vertical ? 0.15 : 0.045,
    1.75,
    vertical ? 0.045 : 0.15,
    "#435454",
    vertical ? 0 : length / 2 - 0.023,
    0.925,
    vertical ? length / 2 - 0.023 : 0,
    0.008,
  );
  batchStaticFurniture(upper, true);
  return upper;
}
/** T junction: stop the divider at the corridor wall axis and bridge both half-tile gaps. */
export function addRoomTJunction(parent: T.Group) {
  const stem = new T.Group();
  stem.position.z = -0.25;
  parent.add(stem);
  addRoomPartition(stem, true, 0.5);
  addRoomPartition(parent, false);
  // Shared post covers all rail ends at the same datum, without a protruding stub.
  round(parent, 0.15, 1.83, 0.15, "#435454", 0, 0.915, 0, 0.01);
}
export function addOfficeRoomSurfaces(
  root: T.Group,
  environment: string,
  context?: OfficeRoomSurfaceContext,
) {
  const rooms = officeRoomsForSurface(environment, context);
  if (!rooms) return;
  const boundary = rooms[0].z + rooms[0].depth + 0.5;
  // Half-cell closures connect partition axes to the perimeter's shared corner axes.
  for (const x of [0.75, 29.25]) {
    const connector = new T.Group();
    connector.position.set(x, 0, boundary);
    root.add(connector);
    addRoomPartition(connector, false, 0.5);
    const end = x < 1 ? 0.5 : 29.5;
    round(root, 0.15, 1.83, 0.15, "#435454", end, 0.915, boundary, 0.01);
  }
  for (const x of rooms.slice(1).map((room) => room.x - 0.5)) {
    const connector = new T.Group();
    connector.position.set(x, 0, 0.75);
    root.add(connector);
    addRoomPartition(connector, true, 0.5);
    round(root, 0.15, 1.83, 0.15, "#435454", x, 0.915, 0.5, 0.01);
  }
  for (const room of rooms) {
    const surface = new T.Mesh(
      new T.PlaneGeometry(room.width, room.depth),
      new T.MeshStandardMaterial({
        color: room.color,
        roughness: room.id === "pantry" ? 0.5 : 0.95,
      }),
    );
    surface.rotation.x = -Math.PI / 2;
    surface.position.set(room.x + room.width / 2, 0.025, room.z + room.depth / 2);
    if (room.id !== "pantry")
      surface.material.userData.surface = room.id === "meeting" ? "fabric" : "wood";
    surface.receiveShadow = true;
    root.add(surface);
    // Visible tile joints in pantry; carpet border in meeting room and CEO rug.
    if (room.id === "pantry") {
      for (let x = room.x; x <= room.x + room.width; x++)
        round(root, 0.015, 0.007, room.depth, "#b8b09f", x, 0.032, room.z + room.depth / 2, 0.002);
      for (let z = room.z; z <= room.z + room.depth; z++)
        round(root, room.width, 0.007, 0.015, "#b8b09f", room.x + room.width / 2, 0.032, z, 0.002);
    } else {
      round(
        root,
        room.width - 1,
        0.012,
        room.depth - 1,
        room.id === "ceo" ? "#a5987b" : "#7f9391",
        room.x + room.width / 2,
        0.036,
        room.z + room.depth / 2,
        0.05,
      );
    }
    for (const x of [room.door, room.door + 2])
      round(root, 0.1, 1.88, 0.18, "#435454", x, 0.94, boundary, 0.01);
    round(root, 2.1, 0.1, 0.18, "#435454", room.door + 1, 1.84, boundary, 0.01);
    // Flat floor label remains legible even when walls are cut away.
    if (typeof document !== "undefined") {
      const canvas = document.createElement("canvas");
      canvas.width = 512;
      canvas.height = 128;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.fillStyle = "#eee9dc";
        ctx.fillRect(0, 0, 512, 128);
        ctx.fillStyle = "#3d5048";
        ctx.font = "600 48px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(roomLabel(room.label, document.documentElement.lang), 256, 64);
        const texture = new T.CanvasTexture(canvas);
        texture.colorSpace = T.SRGBColorSpace;
        const label = new T.Mesh(
          new T.PlaneGeometry(2.1, 0.525),
          new T.MeshBasicMaterial({ map: texture }),
        );
        label.rotation.x = -Math.PI / 2;
        label.position.set(room.door + 1, 0.055, boundary + 0.75);
        root.add(label);
      }
    }
  }
}

export function addPublishingRoomSurfaces(root: T.Group) {
  addOfficeRoomSurfaces(root, "publishing");
}
