import type { CreativeStudioAdd } from "./creative-studio-layout";
import {
  furnishDeskIsland,
  furnishLounge,
  furnishRoomBoundary,
  type OfficeRoomBoundary,
} from "./office-layout-modules";

export const PUBLISHING_SIZE = Object.freeze({ cols: 30, rows: 26 });
export const PUBLISHING_ENTRANCE = Object.freeze({
  fromCol: 14,
  toCol: 16,
  row: 25,
  spawnCol: 15,
  spawnRow: 23,
});
export const PUBLISHING_ROOMS: readonly OfficeRoomBoundary[] = [
  {
    id: "meeting",
    westCol: 0,
    eastCol: 8,
    backRow: 0,
    frontRow: 8,
    doorSide: "right",
    doorCells: [6, 7],
    roaming: true,
  },
];
export const PUBLISHING_DESK_ISLANDS = [
  { col: 5, row: 14 },
  { col: 13, row: 14 },
  { col: 21, row: 14 },
] as const;
export const PUBLISHING_ZONES = [
  { id: "meeting", x: 1, y: 1, width: 7, height: 7, roaming: true },
  { id: "proofing", x: 10, y: 5, width: 10, height: 6, roaming: true },
  { id: "reading", x: 21, y: 1, width: 8, height: 8, roaming: true },
  { id: "work", x: 4, y: 12, width: 22, height: 6, roaming: true },
  { id: "entry", x: 2, y: 20, width: 26, height: 5, roaming: true },
];

export function furnishPublishing(add: CreativeStudioAdd) {
  for (const room of PUBLISHING_ROOMS)
    furnishRoomBoundary(add, room, "publishing-frame", { westCol: 0, eastCol: 29, backRow: 0 });
  add("meeting_table", 3, 3, { variant: "studio-oak" });
  for (const [col, row, direction] of [
    [3, 2, "down"],
    [4, 2, "down"],
    [3, 5, "up"],
    [4, 5, "up"],
  ] as const)
    add("chair", col, row, { variant: "olive-office", direction, destinationTags: ["meeting"] });
  for (const col of [10, 12, 14, 16, 18])
    add("studio_shelf", col, 1, { variant: col === 16 ? "pub-library-ladder" : "pub-library" });
  const olive: CreativeStudioAdd = (type, col, row, placement = {}) =>
    add(type, col, row, {
      ...placement,
      variant: placement.variant === "navy" ? "olive" : placement.variant,
    });
  furnishLounge(olive, 23, 3, "reading");
  add("bookshelf", 21, 1, { variant: "studio-oak" });
  add("studio_counter", 12, 8, { variant: "pub-proof-desk", destinationTags: ["proofing"] });
  for (const col of [12, 13, 15])
    add("studio_stool", col, 9, {
      variant: "olive",
      direction: "up",
      destinationTags: ["proofing"],
    });
  for (const { col, row } of PUBLISHING_DESK_ISLANDS)
    furnishDeskIsland(
      (type, x, y, p = {}) =>
        add(type, x, y, { ...p, variant: type === "chair" ? "olive-office" : p.variant }),
      col,
      row,
      "pub-workstation",
    );
  add("microwave_cabinet", 1, 10, { variant: "coffee-station", direction: "right" });
  add("bookshelf", 1, 13, { variant: "studio-oak", direction: "right" });
  add("office_locker", 1, 17, { variant: "olive" });
  // Connect wall storage to raise the density of publishing props while keeping the central aisle.
  for (const row of [14, 18])
    add("studio_shelf", 1, row, { variant: "pub-newbook-display", direction: "right" });
  for (const col of [10, 18]) add("studio_shelf", col, 9, { variant: "pub-newbook-display" });
  for (const row of [10, 13, 16, 19])
    add("studio_shelf", 27, row, {
      variant: row === 13 || row === 19 ? "pub-binding-bench" : "pub-print-bench",
      direction: "right",
    });
  add("reception_desk", 3, 21, { variant: "studio-oak" });
  add("chair", 3, 20, {
    variant: "olive-office",
    direction: "down",
    destinationTags: ["reception"],
  });
  for (const col of [5, 7, 9, 18, 20, 22])
    add("studio_shelf", col, 23, { variant: "pub-newbook-display" });
  for (const [col, row] of [
    [6, 1],
    [1, 6],
    [10, 3],
    [19, 3],
    [28, 2],
    [27, 7],
    [2, 19],
    [12, 23],
    [25, 22],
  ] as const)
    add("plant", col, row, { variant: "ficus" });
}
