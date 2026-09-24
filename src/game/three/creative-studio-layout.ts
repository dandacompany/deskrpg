import type { AmbientArea, AmbientZone } from "../ambient-zones";
import type { MapObject } from "../../lib/object-types";

export const CREATIVE_STUDIO_SIZE = Object.freeze({ cols: 42, rows: 26 } as const);

/** Collision/architecture contract for the enclosed meeting wing. */
export const CREATIVE_STUDIO_MEETING_BOUNDARY = Object.freeze({
  westCol: 32,
  eastCol: 41,
  frontRow: 10,
  westSolidRows: Object.freeze([1, 2, 3, 4, 5, 6, 7, 10]),
  doorRows: Object.freeze([8, 9]),
});

/** Glass enclosure for the studio director suite; the east opening joins the main spine. */
export const CREATIVE_STUDIO_DIRECTOR_BOUNDARY = Object.freeze({
  northRow: 10,
  eastCol: 9,
  southRow: 22,
  northCols: Object.freeze([1, 2, 3, 4, 5, 6, 7, 8]),
  eastSolidRows: Object.freeze([10, 11, 12, 13, 16, 17, 18, 19, 20, 21, 22]),
  doorRows: Object.freeze([14, 15]),
  southCols: Object.freeze([1, 2, 3, 4, 5, 6, 7, 8]),
});

const area = (x: number, y: number, width: number, height: number): AmbientArea => ({
  x,
  y,
  width,
  height,
});

export type StudioZone = AmbientZone & {
  access: "ambient" | "purpose-only";
  destinationTags: readonly string[];
};

export const CREATIVE_STUDIO_ZONES: readonly StudioZone[] = Object.freeze([
  Object.freeze({
    id: "photo",
    x: 1,
    y: 2,
    width: 9,
    height: 9,
    roaming: false,
    access: "purpose-only" as const,
    destinationTags: Object.freeze(["photo"]),
  }),
  Object.freeze({
    id: "workstations",
    x: 11,
    y: 2,
    width: 19,
    height: 7,
    roaming: true,
    access: "ambient" as const,
    destinationTags: Object.freeze(["work", "desk"]),
    destinationExclusions: Object.freeze([area(11, 2, 1, 7), area(11, 8, 19, 1)]),
  }),
  Object.freeze({
    id: "ideation",
    x: 10,
    y: 9,
    width: 10,
    height: 8,
    roaming: true,
    access: "ambient" as const,
    destinationTags: Object.freeze(["ideation", "collaboration"]),
    destinationExclusions: Object.freeze([area(10, 9, 2, 8), area(10, 15, 10, 2)]),
  }),
  Object.freeze({
    id: "main-lounge",
    x: 22,
    y: 7,
    width: 10,
    height: 8,
    roaming: true,
    access: "ambient" as const,
    destinationTags: Object.freeze(["lounge", "sofa"]),
    destinationExclusions: Object.freeze([area(30, 7, 2, 8)]),
  }),
  Object.freeze({
    id: "production",
    x: 16,
    y: 16,
    width: 14,
    height: 8,
    roaming: true,
    access: "ambient" as const,
    destinationTags: Object.freeze(["production", "worktable"]),
    destinationExclusions: Object.freeze([area(16, 16, 14, 1), area(16, 23, 14, 1)]),
  }),
  Object.freeze({
    id: "studio-director",
    x: 1,
    y: 10,
    width: 9,
    height: 13,
    roaming: false,
    access: "purpose-only" as const,
    destinationTags: Object.freeze(["work", "desk", "meeting", "lounge"]),
  }),
  Object.freeze({
    id: "meeting",
    x: 32,
    y: 2,
    width: 10,
    height: 9,
    roaming: false,
    access: "purpose-only" as const,
    destinationTags: Object.freeze(["meeting"]),
  }),
  Object.freeze({
    id: "pantry",
    x: 32,
    y: 11,
    width: 10,
    height: 8,
    roaming: true,
    access: "ambient" as const,
    destinationTags: Object.freeze(["pantry", "stool"]),
  }),
  Object.freeze({
    id: "small-lounge",
    x: 32,
    y: 19,
    width: 10,
    height: 7,
    roaming: true,
    access: "ambient" as const,
    destinationTags: Object.freeze(["lounge", "sofa"]),
  }),
]);

export type CreativeStudioPlacement = Pick<MapObject, "direction" | "variant" | "destinationTags">;
export type CreativeStudioAdd = (
  type: string,
  col: number,
  row: number,
  placement?: CreativeStudioPlacement,
) => void;

/** Tile anchors ship now; Task 4 must add catalog-local anchors without moving this navigation grid. */
export const CREATIVE_STUDIO_SEAT_CONTRACT = Object.freeze({
  tileGridAnchors: 44,
  deferredCatalogSeatsPerObject: Object.freeze({ studio_sofa: 3, studio_stool: 1 }),
  deferredCatalogAnchors: 13,
  totalAnchors: 57,
} as const);

export function furnishCreativeStudio(add: CreativeStudioAdd) {
  // Photo bay: tall boundary stops short of the two-tile cross aisle at rows 8-9.
  add("photo_cyclorama", 2, 2, { variant: "coral", destinationTags: ["photo"] });
  add("photo_light", 2, 6, { direction: "right", variant: "softbox", destinationTags: ["photo"] });
  add("photo_light", 8, 6, { direction: "left", variant: "softbox", destinationTags: ["photo"] });
  add("photo_camera", 5, 7, { direction: "up", variant: "tripod", destinationTags: ["photo"] });
  add("studio_shelf", 1, 5, {
    direction: "right",
    variant: "equipment",
    destinationTags: ["photo"],
  });
  add("studio_shelf", 5, 5, {
    variant: "prop-storage",
    destinationTags: ["photo"],
  });
  add("photo_light", 7, 7, {
    direction: "left",
    variant: "reflector",
    destinationTags: ["photo"],
  });
  for (const row of [5, 6, 7])
    add("glass_partition", 9, row, { direction: "right", variant: "black-frame" });

  // Rear-left four-person workstation island and storage.
  for (const [col, row] of [
    [13, 3],
    [14, 3],
    [13, 4],
    [14, 4],
  ] as const) {
    add("desk", col, row, { variant: "studio-oak", destinationTags: ["work", "desk"] });
    add("computer", col, row, { variant: "studio-monitor" });
  }
  for (const [col, row, direction] of [
    [13, 2, "down"],
    [14, 2, "down"],
    [13, 5, "up"],
    [14, 5, "up"],
  ] as const)
    add("chair", col, row, {
      direction,
      variant: "office-neutral",
      destinationTags: ["work", "desk"],
    });
  add("studio_shelf", 19, 2, { variant: "credenza" });
  // Place a second cluster of 4-person workstations so small teams can work together.
  for (const [col, row] of [
    [17, 3],
    [18, 3],
    [17, 4],
    [18, 4],
  ] as const) {
    add("desk", col, row, { variant: "studio-oak", destinationTags: ["work", "desk"] });
    add("computer", col, row, { variant: "studio-monitor" });
  }
  for (const [col, row, direction] of [
    [17, 2, "down"],
    [18, 2, "down"],
    [17, 5, "up"],
    [18, 5, "up"],
  ] as const)
    add("chair", col, row, {
      direction,
      variant: "office-neutral",
      destinationTags: ["work", "desk"],
    });
  add("studio_shelf", 20, 6, {
    variant: "materials",
    destinationTags: ["work", "desk"],
  });
  // A third, smaller workstation cluster mirrors the reference's distributed work islands.
  for (const col of [26, 27]) {
    add("desk", col, 3, { variant: "studio-oak", destinationTags: ["work", "desk"] });
    add("computer", col, 3, { variant: "studio-monitor" });
    add("chair", col, 2, {
      direction: "down",
      variant: "office-neutral",
      destinationTags: ["work", "desk"],
    });
  }
  add("plant", 22, 2, { variant: "ficus" });

  // Ideation table. Eight tile-grid chairs are the Task 2 navigation fallback.
  add("studio_round_table", 13, 11, {
    variant: "idea-table",
    destinationTags: ["ideation", "collaboration"],
  });
  for (const [col, row, direction, variant] of [
    [13, 10, "down", "coral"],
    [14, 10, "down", "teal"],
    [15, 10, "down", "mustard"],
    [12, 11, "right", "neutral"],
    [16, 11, "left", "coral"],
    [12, 13, "right", "teal"],
    [16, 13, "left", "mustard"],
    [14, 14, "up", "neutral"],
  ] as const)
    add("chair", col, row, { direction, variant, destinationTags: ["ideation", "collaboration"] });
  add("mobile_board", 17, 10, { direction: "right", variant: "idea-board" });

  // Main social lounge stays west of the two-tile east circulation spine.
  add("studio_sofa", 24, 7, {
    direction: "down",
    variant: "curved-off-white",
    destinationTags: ["lounge", "sofa"],
  });
  add("studio_sofa", 27, 7, {
    direction: "down",
    variant: "curved-off-white",
    destinationTags: ["lounge", "sofa"],
  });
  add("meeting_table", 25, 11, { variant: "round-low", destinationTags: ["lounge"] });
  add("office_armchair", 23, 11, { direction: "right", variant: "teal" });
  add("office_armchair", 28, 11, { direction: "left", variant: "coral" });
  add("plant", 22, 7, { variant: "olive" });
  add("studio_shelf", 22, 14, { variant: "low-divider", destinationTags: ["lounge"] });
  add("plant", 29, 14, { variant: "monstera" });

  // Purpose-only studio director suite: walnut hero desk plus a compact client lounge.
  for (const col of CREATIVE_STUDIO_DIRECTOR_BOUNDARY.northCols)
    add("glass_partition", col, CREATIVE_STUDIO_DIRECTOR_BOUNDARY.northRow, {
      variant: "black-frame",
    });
  for (const row of CREATIVE_STUDIO_DIRECTOR_BOUNDARY.eastSolidRows)
    add("glass_partition", CREATIVE_STUDIO_DIRECTOR_BOUNDARY.eastCol, row, {
      direction: "right",
      variant: "black-frame",
    });
  for (const col of CREATIVE_STUDIO_DIRECTOR_BOUNDARY.southCols)
    add("glass_partition", col, CREATIVE_STUDIO_DIRECTOR_BOUNDARY.southRow, {
      variant: "black-frame",
    });
  for (const col of [1, 2, 3, 4, 5])
    add("bookshelf", col, 11, { variant: "studio-director", destinationTags: ["work"] });
  add("low_cabinet", 6, 11, { variant: "studio-director", destinationTags: ["work"] });
  add("executive_desk", 2, 13, {
    direction: "down",
    variant: "studio-director",
    destinationTags: ["work", "desk"],
  });
  add("computer", 3, 13, { variant: "director-monitor" });
  add("chair", 3, 12, {
    direction: "down",
    variant: "studio-director",
    destinationTags: ["work", "desk"],
  });
  for (const col of [2, 5])
    add("chair", col, 16, {
      direction: "up",
      variant: "studio-director",
      destinationTags: ["meeting"],
    });
  add("floor_lamp", 7, 17, { variant: "studio-director" });
  add("plant", 1, 18, { variant: "olive" });
  add("office_sofa", 2, 19, {
    direction: "right",
    variant: "studio-director",
    destinationTags: ["meeting", "lounge"],
  });
  add("meeting_table", 4, 19, {
    variant: "studio-director",
    destinationTags: ["meeting", "lounge"],
  });
  add("office_armchair", 7, 19, {
    direction: "left",
    variant: "studio-director",
    destinationTags: ["meeting", "lounge"],
  });
  add("plant", 7, 21, { variant: "monstera" });

  // Dressed production table with eight independently reachable legacy chairs.
  add("studio_worktable", 20, 18, {
    variant: "dressed",
    destinationTags: ["production", "worktable"],
  });
  for (const [col, row, direction] of [
    [20, 17, "down"],
    [22, 17, "down"],
    [23, 17, "down"],
    [25, 17, "down"],
    [20, 21, "up"],
    [22, 21, "up"],
    [23, 21, "up"],
    [25, 21, "up"],
  ] as const)
    add("chair", col, row, {
      direction,
      variant: "side-neutral",
      destinationTags: ["production", "worktable"],
    });
  add("studio_shelf", 16, 21, { variant: "sample-rack", destinationTags: ["production"] });
  add("studio_shelf", 27, 18, {
    direction: "right",
    variant: "material-library",
    destinationTags: ["production"],
  });
  add("studio_shelf", 27, 21, { variant: "print-rack", destinationTags: ["production"] });

  // Glass meeting enclosure. The opening at rows 8-9 connects to the east spine.
  for (const row of CREATIVE_STUDIO_MEETING_BOUNDARY.westSolidRows)
    add("glass_partition", CREATIVE_STUDIO_MEETING_BOUNDARY.westCol, row, {
      direction: "right",
      variant: "black-frame",
    });
  for (
    let col = CREATIVE_STUDIO_MEETING_BOUNDARY.westCol + 1;
    col < CREATIVE_STUDIO_MEETING_BOUNDARY.eastCol;
    col++
  )
    add("glass_partition", col, CREATIVE_STUDIO_MEETING_BOUNDARY.frontRow, {
      variant: "black-frame",
    });
  add("conference_table", 35, 4, { variant: "studio-oak", destinationTags: ["meeting"] });
  for (const [col, row, direction] of [
    [35, 3, "down"],
    [38, 3, "down"],
    [35, 6, "up"],
    [38, 6, "up"],
    [34, 4, "right"],
    [39, 4, "left"],
    [36, 7, "up"],
    [37, 7, "up"],
  ] as const)
    add("chair", col, row, { direction, variant: "meeting-neutral", destinationTags: ["meeting"] });
  add("meeting_display", 36, 2, { variant: "wall-display" });
  add("mobile_board", 39, 8, { direction: "right", variant: "meeting-board" });

  // Pantry and bar.
  add("studio_shelf", 33, 11, { variant: "pantry-storage" });
  add("studio_counter", 37, 11, { variant: "coral-backed", destinationTags: ["pantry"] });
  for (const col of [36, 37, 38, 39])
    add("studio_stool", col, 12, {
      direction: "up",
      variant: "oak",
      destinationTags: ["pantry", "stool"],
    });
  add("kitchen_counter", 33, 14, { variant: "sink", destinationTags: ["pantry"] });
  add("microwave_cabinet", 35, 14, {
    variant: "coffee-station",
    destinationTags: ["pantry"],
  });
  add("refrigerator", 40, 14, { variant: "under-counter", destinationTags: ["pantry"] });
  add("plant", 40, 17, { variant: "ficus" });

  // Informal front-right lounge and reference storage.
  add("studio_shelf", 39, 19, { variant: "reference" });
  add("studio_sofa", 35, 20, {
    direction: "down",
    variant: "teal",
    destinationTags: ["lounge", "sofa"],
  });
  add("meeting_table", 35, 22, { variant: "round-low", destinationTags: ["lounge"] });
  add("office_armchair", 33, 22, { direction: "right", variant: "mustard" });
  add("office_armchair", 38, 22, {
    direction: "left",
    variant: "coral",
    destinationTags: ["lounge", "sofa"],
  });
  add("plant", 32, 24, { variant: "monstera" });
  add("plant", 40, 24, { variant: "olive" });
}
