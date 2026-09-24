import * as T from "three";
import type { MapSnapshot } from "./bridge";
import { round, cylinder } from "./primitives";
import { surfaceTexture } from "./surface-detail";

export function isPublishingMap(map: Pick<MapSnapshot, "environment" | "environmentVersion">) {
  return map.environment === "publishing" && (map.environmentVersion ?? 0) >= 3;
}
/** The publisher finish: low front walls, cream back walls, fabric rugs and task lighting. */
export function addPublishingArchitecture(root: T.Group, map: MapSnapshot) {
  const g = new T.Group();
  g.name = "publishing-architecture";
  const meetingWalls: T.Object3D[] = [];
  g.userData.meetingWalls = meetingWalls;
  root.add(g);
  const plaster = new T.MeshStandardMaterial({ color: "#e9e1cf", roughness: 0.94 });
  const cap = new T.MeshStandardMaterial({ color: "#b6b0a1", roughness: 0.77 });
  const wall = (w: number, h: number, d: number, x: number, z: number) => {
    const host = new T.Group();
    host.userData.meetingWall = true;
    meetingWalls.push(host);
    g.add(host);
    round(host, w, h, d, plaster, x, h / 2, z, 0.025);
    round(host, w + 0.05, 0.09, d + 0.06, cap, x, h + 0.025, z, 0.012);
    // Both vertical and horizontal walls protrude along the thin axis to remove coplanarity between walls and baseboards.
    round(
      host,
      w + (w < d ? 0.045 : 0),
      0.14,
      d + (w < d ? 0 : 0.045),
      "#c9bba3",
      x,
      0.09,
      z,
      0.009,
    );
  };
  wall(map.cols, 3.05, 0.24, map.cols / 2, 0.5);
  wall(0.24, 2.1, map.rows - 1, 0.5, map.rows / 2);
  wall(0.24, 2.1, map.rows - 1, map.cols - 0.5, map.rows / 2);
  const doorStart = Math.floor(map.cols / 2) - 1,
    doorEnd = doorStart + 3;
  wall(doorStart - 0.5, 0.8, 0.24, (doorStart + 0.5) / 2, map.rows - 0.5);
  wall(map.cols - 0.5 - doorEnd, 0.8, 0.24, (map.cols - 0.5 + doorEnd) / 2, map.rows - 0.5);
  // Door frames are placed outside the logical entrance so they do not block the access path.
  for (const x of [doorStart, doorEnd])
    round(g, 0.12, 1.55, 0.25, "#65715a", x, 0.775, map.rows - 0.5, 0.012);
  const fabric = surfaceTexture("fabric");
  fabric.repeat.set(5, 5);
  const rug = (x: number, z: number, w: number, d: number) => {
    const mat = new T.MeshStandardMaterial({
      color: "#b8a88d",
      bumpMap: fabric,
      bumpScale: 0.012,
      roughness: 0.98,
    });
    round(g, w, 0.025, d, mat, x, 0.018, z, 0.014);
  };
  // Take rug positions from furniture tags so the layout is not declared twice.
  const desks = map.objects.filter(
    (o) => o.type === "reception_desk" && o.destinationTags?.includes("work"),
  );
  const starts = desks
    .filter((o) => o.direction === "up")
    .filter((o) => !desks.some((b) => b.row === o.row && b.col === o.col - 2));
  for (const d of starts) rug(d.col + 2, d.row + 1, 5.4, 4.4);
  const proof = map.objects.find((o) => o.variant === "pub-proof-desk");
  if (proof) rug(proof.col + 2, proof.row + 1, 5.6, 3.8);
  const lounge = map.objects.find((o) => o.type === "studio_sofa");
  if (lounge) rug(lounge.col + 1.5, lounge.row + 1.5, 6.6, 4.7);
  // Paintings and frames are created as a separate group so the props can be reused.
  for (const [x, z] of [
    [23, 0.66],
    [26, 0.66],
    [1, 11],
    [1, 17],
    [28.8, 14],
  ] as const) {
    const frame = new T.Group();
    frame.position.set(x, 1.65, z);
    if (x === 1) frame.rotation.y = Math.PI / 2;
    if (x > 28) frame.rotation.y = -Math.PI / 2;
    g.add(frame);
    round(frame, 1, 0.95, 0.06, "#8b7151", 0, 0, 0, 0.014);
    round(frame, 0.88, 0.83, 0.015, "#e8dfc9", 0, 0, 0.04, 0.003);
    round(frame, 0.59, 0.34, 0.009, "#85917b", 0, -0.13, 0.05, 0.015);
    round(frame, 0.29, 0.29, 0.011, "#b8a082", 0.13, 0.1, 0.052, 0.025);
  }
  // Meeting room lighting is derived from the actual meeting table position.
  const table = map.objects.find((o) => o.type === "meeting_table" && o.variant === "studio-oak");
  if (table) {
    rug(table.col + 1, table.row + 1, 4.8, 4.5);
    for (const x of [table.col + 0.45, table.col + 1.55]) {
      cylinder(g, 0.012, 0.012, 0.7, "#414b3c", x, 2.5, table.row + 1);
      const shade = new T.Mesh(
        new T.SphereGeometry(0.2, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2),
        new T.MeshStandardMaterial({ color: "#617254", roughness: 0.6, side: T.DoubleSide }),
      );
      shade.position.set(x, 2.15, table.row + 1);
      g.add(shade);
    }
  }
  return g;
}
