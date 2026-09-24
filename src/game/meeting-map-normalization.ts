import {
  computeOccupiedTiles,
  detectAndConvertMapData,
  getObjectDimensions,
  OBJECT_TYPES,
  TILE_ID_TO_OBJECT,
  type MapObject,
  type MapData,
} from "../lib/object-types";
import { projectTiledGeometry, type TiledGeometryMap } from "../lib/tiled-geometry";
import { effectiveMapSpawn, isCreativeStudioMap } from "../lib/effective-map-spawn";
import { clearSegment, findPath } from "./navigation";
import { furnitureSeats } from "./three/seating";
import { officeRoomsForSurface } from "./three/office-room-layout";
import { CREATIVE_STUDIO_ZONES } from "./three/creative-studio-layout";
import {
  insideMeetingSpace,
  MEETING_SPACE_VERSION,
  type MeetingBounds,
  type MeetingSpace,
} from "./meeting-space";

type JsonMap = Record<string, unknown>;
type Geometry = {
  cols: number;
  rows: number;
  floor: number[][];
  walls: number[][];
  objects: MapObject[];
  blocked: string[];
  tiled: boolean;
};
const record = (v: unknown): v is JsonMap => !!v && typeof v === "object" && !Array.isArray(v);
const grid = (v: unknown): v is number[][] =>
  Array.isArray(v) &&
  v.length > 0 &&
  v.every(
    (r) =>
      Array.isArray(r) && r.length === v[0].length && r.every((n) => Number.isInteger(n) && n >= 0),
  );
const key = (x: number, y: number) => `${x},${y}`;
const wall = (o: MapObject) => o.type.includes("wall");
function invalid(reason: string): never {
  throw new Error(`회의실 맵 오류: ${reason}`);
}

/** Merge only the floor and furniture the renderer edited. Tiled collisions and unknown layers are saved as is. */
export function serializeMeetingMap(source: unknown, edits: MapData): JsonMap {
  return prepareMeetingMapSave(source, edits).mapData;
}
export function prepareMeetingMapSave(
  source: unknown,
  edits: MapData,
): { mapData: JsonMap; objectIds: Record<string, string> } {
  const objectIds: Record<string, string> = {};
  if (!record(source) || !("tiledversion" in source))
    return {
      mapData: normalizeMeetingMap({ ...(record(source) ? source : {}), ...edits }).mapData,
      objectIds,
    };
  const map = structuredClone(source) as unknown as TiledGeometryMap;
  const pending = new Map(edits.objects.map((o) => [o.id, o]));
  let nextId = Math.max(
    Number(source.nextobjectid) || 1,
    ...map.layers.flatMap((l) => (l.objects || []).map((o) => o.id + 1)),
  );
  const update = (
    original: NonNullable<TiledGeometryMap["layers"][number]["objects"]>[number],
    edit: MapObject,
  ) => {
    const properties = [...(original.properties || [])];
    for (const name of ["direction", "variant", "destinationTags"] as const)
      if (edit[name] !== undefined) {
        const value = name === "destinationTags" ? JSON.stringify(edit[name]) : edit[name];
        const found = properties.find((p) => p.name === name);
        if (found) found.value = value;
        else properties.push({ name, value });
      }
    return {
      ...original,
      type: edit.type,
      x: edit.col * 32,
      y: edit.row * 32,
      ...(properties.length ? { properties } : {}),
    };
  };
  for (const layer of map.layers) {
    const name = layer.name.toLowerCase();
    if (layer.type === "tilelayer" && (name === "floor" || name === "walls"))
      layer.data = (name === "floor" ? edits.layers.floor : edits.layers.walls)
        .slice(0, map.height)
        .flatMap((row) => row.slice(0, map.width));
    if (layer.type !== "objectgroup" || name === "collision") continue;
    layer.objects = (layer.objects || []).flatMap((original) => {
      if (!OBJECT_TYPES[original.type]) return [original];
      const id = `${layer.id}:${original.id}`,
        edit = pending.get(id);
      pending.delete(id);
      return edit ? [update(original, edit)] : [];
    });
  }
  if (pending.size) {
    const id = Math.max(0, ...map.layers.map((l) => l.id)) + 1;
    map.layers.push({
      id,
      name: "Saved objects",
      type: "objectgroup",
      objects: [...pending.values()].map((edit) => {
        const objectId = nextId++;
        objectIds[edit.id] = `${id}:${objectId}`;
        return update({ id: objectId, type: edit.type, x: edit.col * 32, y: edit.row * 32 }, edit);
      }),
    });
    Object.assign(map, { nextlayerid: id + 1 });
  }
  Object.assign(map, { nextobjectid: nextId });
  return { mapData: normalizeMeetingMap(map).mapData, objectIds };
}

/** A geometric projection shared by server and browser that does not touch the original. */
export function projectMeetingMap(input: unknown): Geometry {
  if (record(input) && "tiledversion" in input) {
    if (
      !Number.isInteger(input.width) ||
      !Number.isInteger(input.height) ||
      Number(input.width) < 1 ||
      Number(input.height) < 1 ||
      Number(input.width) > 4096 ||
      Number(input.height) > 4096 ||
      !Array.isArray(input.layers)
    )
      invalid("Tiled 크기 또는 레이어가 잘못되었습니다");
    const map = input as unknown as TiledGeometryMap;
    for (const layer of map.layers)
      if (
        layer.type === "tilelayer" &&
        (!Array.isArray(layer.data) || layer.data.length !== map.width * map.height)
      )
        invalid("타일 레이어 크기가 맵과 다릅니다");
    const g = projectTiledGeometry(map);
    const blocked = new Set(g.blocked);
    if (!map.layers.some((l) => l.name.toLowerCase() === "collision" && l.type === "tilelayer"))
      g.walls.forEach((row, y) =>
        row.forEach((tile, x) => {
          if (tile === 2) blocked.add(key(x, y));
        }),
      );
    return { ...g, blocked: [...blocked] };
  }
  if (!(
    grid(input) ||
    (record(input) &&
      ((record(input.layers) &&
        grid(input.layers.floor) &&
        grid(input.layers.walls) &&
        Array.isArray(input.objects)) ||
        (grid(input.floor) && grid(input.walls) && grid(input.furniture))))
  ))
    invalid("지원하지 않는 맵 데이터입니다");
  const legacy = detectAndConvertMapData(input, 40, 30);
  const cols = Math.max(40, legacy.layers.floor[0].length),
    rows = Math.max(30, legacy.layers.floor.length);
  const floor = Array.from({ length: rows }, (_, y) =>
    Array.from({ length: cols }, (_, x) => legacy.layers.floor[y]?.[x] ?? 1),
  );
  const walls = Array.from({ length: rows }, (_, y) =>
    Array.from({ length: cols }, (_, x) => legacy.layers.walls[y]?.[x] ?? 0),
  );
  // The old converter generates new IDs, so only formats without saved IDs are pinned by coordinates.
  const objects = legacy.objects.map((o, i) =>
    record(input) && Array.isArray(input.objects)
      ? { ...o }
      : { ...o, id: `legacy-${o.col}-${o.row}-${i}` },
  );
  const blocked = computeOccupiedTiles(objects);
  legacy.layers.walls.forEach((row, y) =>
    row.forEach((tile, x) => {
      if (tile === 2) blocked.add(key(x, y));
    }),
  );
  for (const [index, layer] of [legacy.layers.floor, legacy.layers.walls].entries())
    layer.forEach((row, y) =>
      row.forEach((tile, x) => {
        const id = `tile-${index}-${x}-${y}`;
        if (TILE_ID_TO_OBJECT[tile] && !objects.some((o) => o.id === id))
          objects.push({ id, type: TILE_ID_TO_OBJECT[tile], col: x, row: y });
      }),
    );
  for (const k of computeOccupiedTiles(objects)) blocked.add(k);
  return {
    cols,
    rows,
    floor,
    walls,
    objects,
    blocked: [...blocked],
    tiled: false,
  };
}

function walkable(g: Geometry) {
  const blocked = new Set(g.blocked);
  return (x: number, y: number) =>
    Number.isInteger(x) &&
    Number.isInteger(y) &&
    x >= 0 &&
    y >= 0 &&
    x < g.cols &&
    y < g.rows &&
    !blocked.has(key(x, y));
}
function component(g: Geometry, start: { x: number; y: number }) {
  const can = walkable(g),
    found = new Set<string>();
  if (!can(start.x, start.y)) return found;
  const queue = [start];
  found.add(key(start.x, start.y));
  for (let i = 0; i < queue.length; i++)
    for (const [dx, dy] of [
      [1, 0],
      [0, 1],
      [-1, 0],
      [0, -1],
    ]) {
      const p = { x: queue[i].x + dx, y: queue[i].y + dy },
        k = key(p.x, p.y);
      if (can(p.x, p.y) && !found.has(k)) {
        found.add(k);
        queue.push(p);
      }
    }
  return found;
}
function origin(g: Geometry, config?: unknown, map?: JsonMap) {
  if (isCreativeStudioMap(map)) {
    const spawn = effectiveMapSpawn(map, config);
    if (spawn) return { x: spawn.col, y: spawn.row };
  }
  if (record(config) && Number.isInteger(config.spawnCol) && Number.isInteger(config.spawnRow))
    return { x: Number(config.spawnCol), y: Number(config.spawnRow) };
  const spawn = g.objects.find((o) => o.type === "spawn");
  if (spawn) return { x: spawn.col, y: spawn.row };
  if (g.tiled && map) {
    const raw = (map as unknown as TiledGeometryMap).layers
      .flatMap((l) => l.objects || [])
      .find((o) => o.type === "spawn" || (o as { name?: string }).name === "spawn");
    if (raw) return { x: Math.floor(raw.x / 32), y: Math.floor(raw.y / 32) };
  }
  const can = walkable(g);
  for (let y = 0; y < g.rows; y++) for (let x = 0; x < g.cols; x++) if (can(x, y)) return { x, y };
  return invalid("이동 가능한 입구가 없습니다");
}
function spaceFor(
  g: Geometry,
  b: MeetingBounds,
  id: string,
  reach: Set<string>,
): MeetingSpace | null {
  if (
    ![b.x, b.y, b.width, b.height].every(Number.isInteger) ||
    b.width < 3 ||
    b.height < 3 ||
    b.x < 0 ||
    b.y < 0 ||
    b.x + b.width > g.cols ||
    b.y + b.height > g.rows
  )
    return null;
  const inside = (x: number, y: number) => insideMeetingSpace(b, x, y),
    can = walkable(g);
  const table = g.objects.some(
    (o) => ["conference_table", "meeting_table"].includes(o.type) && inside(o.col, o.row),
  );
  if (!table) return null;
  const seats = furnitureSeats(g.objects).filter(
    (s) =>
      inside(s.anchorX ?? s.x, s.anchorZ ?? s.z) &&
      reach.has(key(Math.floor(s.anchorX ?? s.x), Math.floor(s.anchorZ ?? s.z))) &&
      clearSegment(
        { x: (s.anchorX ?? s.x) - 0.5, y: (s.anchorZ ?? s.z) - 0.5 },
        { x: (s.anchorX ?? s.x) - 0.5, y: (s.anchorZ ?? s.z) - 0.5 },
        can,
      ),
  );
  const seatIds = [
    ...new Set(seats.map((s) => `${(s.anchorX ?? s.x) * 32}:${(s.anchorZ ?? s.z) * 32}`)),
  ];
  if (!seatIds.length) return null;
  let entry: { x: number; y: number } | undefined;
  for (let y = b.y; y < b.y + b.height && !entry; y++)
    for (let x = b.x; x < b.x + b.width && !entry; x++) {
      if (!reach.has(key(x, y)) || !can(x, y)) continue;
      if (
        [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ].some(([dx, dy]) => !inside(x + dx, y + dy) && can(x + dx, y + dy))
      )
        entry = { x: x + 0.5, y: y + 0.5 };
    }
  if (!entry) return null;
  const entryTile = { x: Math.floor(entry.x), y: Math.floor(entry.y) };
  // Keep the actual seating path clear. Waiting people do not occupy the entrance corridor.
  const paths = seatIds.map((id) => {
    const [x, y] = id.split(":").map(Number);
    return findPath(entryTile.x, entryTile.y, Math.floor(x / 32), Math.floor(y / 32), can, (a, b) =>
      clearSegment(a, b, can),
    );
  });
  if (paths.some((p) => !p)) return null;
  const inAisle = (x: number, y: number) =>
    paths.some((path) =>
      path!.some((b, i) => {
        if (i === 0) return Math.hypot(x - b.x, y - b.y) < 0.65;
        const a = path![i - 1],
          dx = b.x - a.x,
          dy = b.y - a.y;
        const t = Math.max(
          0,
          Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy || 1)),
        );
        return Math.hypot(x - a.x - t * dx, y - a.y - t * dy) < 0.65;
      }),
    );
  const standingPositions: MeetingSpace["standingPositions"] = [];
  for (let y = b.y + 1; y < b.y + b.height - 1; y++)
    for (let x = b.x + 1; x < b.x + b.width - 1; x++)
      if (
        reach.has(key(x, y)) &&
        clearSegment({ x, y }, { x, y }, can) &&
        !inAisle(x, y) &&
        !seatIds.includes(`${(x + 0.5) * 32}:${(y + 0.5) * 32}`) &&
        Math.hypot(x + 0.5 - entry.x, y + 0.5 - entry.y) > 1.5
      )
        standingPositions.push({ x: (x + 0.5) * 32, y: (y + 0.5) * 32, direction: "up" });
  if (!standingPositions.length) return null;
  const near = (x: number, y: number) =>
    x >= b.x - 1 && y >= b.y - 1 && x <= b.x + b.width && y <= b.y + b.height;
  const wallTileKeys: string[] = [];
  g.walls.forEach((row, y) =>
    row.forEach((tile, x) => {
      if (tile && near(x, y)) wallTileKeys.push(key(x, y));
    }),
  );
  return {
    id,
    version: MEETING_SPACE_VERSION,
    bounds: b,
    entry,
    seatIds,
    standingPositions,
    wallObjectIds: g.objects.filter((o) => wall(o) && near(o.col, o.row)).map((o) => o.id),
    wallTileKeys,
  };
}

function candidates(map: JsonMap, g: Geometry): Array<{ id: string; bounds: MeetingBounds }> {
  if (record(map.meetingSpace) && record(map.meetingSpace.bounds))
    return [
      {
        id: String(map.meetingSpace.id || "meeting"),
        bounds: map.meetingSpace.bounds as MeetingBounds,
      },
    ];
  const layers = Array.isArray(map.layers)
    ? (map.layers as Array<{ properties?: Array<{ name: string; value: unknown }> }>)
    : [];
  const props = layers.flatMap((l) => l.properties || []);
  const markedRooms = g.tiled
    ? (map as unknown as TiledGeometryMap).layers.flatMap((layer) =>
        (layer.objects || [])
          .filter((object) => object.type === "meeting_room")
          .map((object) => ({
            id: `meeting-${layer.id}:${object.id}`,
            bounds: {
              x: object.x / 32,
              y: object.y / 32,
              width: (object.width || 0) / 32,
              height: (object.height || 0) / 32,
            },
          })),
      )
    : [];
  if (markedRooms.length) return markedRooms;
  const env = props.find((p) => p.name === "officeEnvironment")?.value;
  if (typeof env === "string") {
    const version = props.find((p) => p.name === "officeEnvironmentVersion")?.value;
    if (env === "agency" && version !== 2) {
      const z = CREATIVE_STUDIO_ZONES.find((z) => z.id === "meeting")!;
      return [
        {
          id: "meeting",
          bounds: { x: z.x, y: z.y, width: Math.min(z.width, g.cols - z.x), height: z.height },
        },
      ];
    }
    const room = officeRoomsForSurface(env, {
      environmentVersion: typeof version === "number" ? version : undefined,
      hasLegacyPartitions: g.objects.some((o) => o.type === "room_wall_h"),
    })?.find((r) => r.id === "meeting");
    if (room)
      return [
        { id: "meeting", bounds: { x: room.x, y: room.z, width: room.width, height: room.depth } },
      ];
  }
  const explicit: Array<{ id: string; bounds: MeetingBounds }> = [];
  const ambient = props.find((p) => p.name === "ambientZones")?.value;
  if (ambient !== undefined) {
    let zones: unknown;
    try {
      zones = typeof ambient === "string" ? JSON.parse(ambient) : ambient;
    } catch {
      invalid("회의실 영역 속성이 올바른 JSON이 아닙니다");
    }
    if (Array.isArray(zones))
      for (const z of zones)
        if (
          record(z) &&
          (z.id === "meeting" ||
            z.kind === "meeting" ||
            (env === "trading" &&
              Number(props.find((p) => p.name === "officeEnvironmentVersion")?.value) >= 3 &&
              z.id === "conference"))
        )
          explicit.push({
            id: String(z.id),
            bounds: {
              x: Number(z.x),
              y: Number(z.y),
              width: Number(z.width),
              height: Number(z.height),
            },
          });
  }
  if (explicit.length) return explicit;
  // A lounge with only a name is not a candidate. Only meeting tables enclosed by walls are inferred.
  const walls = new Set(g.objects.filter(wall).map((o) => key(o.col, o.row)));
  g.walls.forEach((r, y) =>
    r.forEach((t, x) => {
      if (t === 2) walls.add(key(x, y));
    }),
  );
  const result: Array<{ id: string; bounds: MeetingBounds }> = [];
  for (const table of g.objects.filter((o) =>
    ["conference_table", "meeting_table"].includes(o.type),
  )) {
    const size = getObjectDimensions(table.type, table.direction);
    let left = table.col - 1,
      right = table.col + size.width,
      top = table.row - 1,
      bottom = table.row + size.height;
    while (left >= 0 && !walls.has(key(left, table.row))) left--;
    while (right < g.cols && !walls.has(key(right, table.row))) right++;
    while (top >= 0 && !walls.has(key(table.col, top))) top--;
    while (bottom < g.rows && !walls.has(key(table.col, bottom))) bottom++;
    if (left < 0 || top < 0 || right >= g.cols || bottom >= g.rows) continue;
    let gaps = 0;
    for (let x = left; x <= right; x++) {
      if (!walls.has(key(x, top))) gaps++;
      if (!walls.has(key(x, bottom))) gaps++;
    }
    for (let y = top + 1; y < bottom; y++) {
      if (!walls.has(key(left, y))) gaps++;
      if (!walls.has(key(right, y))) gaps++;
    }
    if (gaps > 0 && gaps <= 2)
      result.push({
        id: `meeting-${table.id}`,
        bounds: { x: left + 1, y: top + 1, width: right - left - 1, height: bottom - top - 1 },
      });
  }
  return result.filter(
    (v, i) => result.findIndex((p) => JSON.stringify(p.bounds) === JSON.stringify(v.bounds)) === i,
  );
}

/** Only the return value is used; DB writes are handled by the caller's existing authorized save path. */
export function normalizeMeetingMap(
  input: unknown,
  config?: unknown,
): { mapData: JsonMap; meetingSpace: MeetingSpace } {
  let g = projectMeetingMap(input);
  const map: JsonMap = g.tiled
    ? structuredClone(input as JsonMap)
    : {
        ...(record(input) ? structuredClone(input) : {}),
        layers: { floor: structuredClone(g.floor), walls: structuredClone(g.walls) },
        objects: structuredClone(g.objects),
      };
  const start = origin(g, config, map),
    reach = component(g, start);
  if (!reach.size) invalid("스폰에서 이동 경로를 찾을 수 없습니다");
  const choices = candidates(map, g);
  if (choices.length === 1) {
    const space = spaceFor(g, choices[0].bounds, choices[0].id, reach);
    if (space) {
      const markers = record(map.meetingSpace) ? map.meetingSpace.generatedAnnexWalls : undefined;
      if (Array.isArray(markers)) {
        const objects = new Map(g.objects.map((o) => [o.id, o]));
        const seen = new Set<string>();
        space.generatedAnnexWalls = markers.filter((marker) => {
          if (!record(marker) || typeof marker.id !== "string" || seen.has(marker.id)) return false;
          const object = objects.get(marker.id);
          if (
            !object ||
            object.type !== "room_wall_h" ||
            marker.type !== object.type ||
            marker.col !== object.col ||
            marker.row !== object.row ||
            !["horizontal", "vertical", "corner", "hidden"].includes(String(marker.display))
          )
            return false;
          seen.add(marker.id);
          return true;
        }) as NonNullable<MeetingSpace["generatedAnnexWalls"]>;
      }
      map.meetingSpace = space;
      return { mapData: map, meetingSpace: space };
    }
    const layers = Array.isArray(map.layers) ? map.layers : [];
    const explicitRoom = layers.some(
      (l) =>
        record(l) &&
        Array.isArray(l.objects) &&
        l.objects.some((o) => record(o) && o.type === "meeting_room"),
    );
    const explicitZones = layers.some(
      (l) =>
        record(l) &&
        Array.isArray(l.properties) &&
        l.properties.some((p) => record(p) && p.name === "ambientZones"),
    );
    if (explicitRoom || explicitZones)
      invalid("지정된 회의실의 입구·좌석·대기 위치가 유효하지 않습니다");
  }
  if (record(map.meetingSpace)) invalid("지정된 회의실의 입구·좌석·대기 위치가 유효하지 않습니다");
  // Connect by opening just one wall on the right or bottom boundary. Interior obstacles are not touched.
  let edge: { x: number; y: number; side: "right" | "bottom" } | undefined;
  const occupied = computeOccupiedTiles(g.objects.filter((o) => !wall(o)));
  for (let y = 1; y < g.rows - 1 && !edge; y++)
    if (reach.has(key(g.cols - 2, y)) && !occupied.has(key(g.cols - 1, y)))
      edge = { x: g.cols - 1, y, side: "right" };
  for (let x = 1; x < g.cols - 1 && !edge; x++)
    if (reach.has(key(x, g.rows - 2)) && !occupied.has(key(x, g.rows - 1)))
      edge = { x, y: g.rows - 1, side: "bottom" };
  if (!edge) invalid("기존 배치를 보존하며 가장자리 연결 통로를 만들 수 없습니다");
  const oldCols = g.cols,
    oldRows = g.rows;
  const b: MeetingBounds =
    edge.side === "right"
      ? { x: oldCols + 2, y: edge.y, width: 10, height: 9 }
      : { x: edge.x, y: oldRows + 2, width: 10, height: 9 };
  const cols = Math.max(oldCols, b.x + b.width + 1),
    rows = Math.max(oldRows, b.y + b.height + 1);
  if (cols > 4096 || rows > 4096) invalid("증축 후 맵 크기가 지원 범위를 넘습니다");
  const corridor = new Set<string>();
  if (edge.side === "right") for (let x = edge.x; x <= b.x; x++) corridor.add(key(x, edge.y));
  else for (let y = edge.y; y <= b.y; y++) corridor.add(key(edge.x, y));
  const additions: MapObject[] = [];
  const add = (type: string, x: number, y: number) =>
    additions.push({ id: `meeting-v1-${type}-${x}-${y}`, type, col: x, row: y });
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols; x++) {
      if (x < oldCols && y < oldRows) continue;
      if (!insideMeetingSpace(b, x, y) && !corridor.has(key(x, y))) add("room_wall_h", x, y);
    }
  add("conference_table", b.x + 3, b.y + 3);
  for (const x of [b.x + 3, b.x + 6]) {
    add("chair", x, b.y + 2);
    add("chair", x, b.y + 5);
  }
  add("chair", b.x + 2, b.y + 3);
  add("chair", b.x + 7, b.y + 3);
  const open = key(edge.x, edge.y);
  const generatedIds = new Map(additions.map((o) => [o.id, o.id]));
  if (g.tiled) {
    const tiled = map as unknown as TiledGeometryMap;
    const tilesets = Array.isArray(map.tilesets) ? map.tilesets.filter(record) : [];
    for (const layer of tiled.layers) {
      if (layer.type === "tilelayer") {
        const old = layer.data!;
        // Reuse only existing floors whose definition is confirmed. Flip flags are stripped only for the check.
        const floorGid =
          layer.name.toLowerCase() === "floor"
            ? (old.find((value) => {
                const gid = value & 0x0fffffff;
                return (
                  gid > 0 &&
                  tilesets.some(
                    (set) =>
                      typeof set.firstgid === "number" &&
                      typeof set.tilecount === "number" &&
                      Number.isInteger(set.firstgid) &&
                      set.firstgid > 0 &&
                      Number.isInteger(set.tilecount) &&
                      gid >= set.firstgid &&
                      gid < set.firstgid + set.tilecount,
                  )
                );
              }) ?? 0)
            : 0;
        layer.data = Array.from({ length: cols * rows }, (_, i) => {
          const x = i % cols,
            y = Math.floor(i / cols);
          if (key(x, y) === open && ["walls", "collision"].includes(layer.name.toLowerCase()))
            return 0;
          return x < oldCols && y < oldRows ? old[y * oldCols + x] : floorGid;
        });
        Object.assign(layer, { width: cols, height: rows });
      } else
        for (const o of layer.objects || [])
          if (key(Math.floor(o.x / 32), Math.floor(o.y / 32)) === open) {
            if (o.type.includes("wall")) o.type = "meeting_door";
            else if (layer.name.toLowerCase() === "collision")
              invalid("통로 경계의 충돌 객체를 안전하게 개방할 수 없습니다");
          }
    }
    const layerId = Math.max(0, ...tiled.layers.map((l) => l.id)) + 1;
    const nextId = Math.max(
      Number(map.nextobjectid) || 1,
      ...tiled.layers.flatMap((l) => (l.objects || []).map((o) => o.id + 1)),
    );
    additions.forEach((object, i) => generatedIds.set(object.id, `${layerId}:${nextId + i}`));
    tiled.layers.push({
      id: layerId,
      name: "Meeting annex",
      type: "objectgroup",
      objects: additions.map((o, i) => ({
        id: nextId + i,
        type: o.type,
        x: o.col * 32,
        y: o.row * 32,
        width: 32,
        height: 32,
      })),
    });
    Object.assign(map, {
      width: cols,
      height: rows,
      nextlayerid: layerId + 1,
      nextobjectid: nextId + additions.length,
    });
  } else {
    const floor = Array.from({ length: rows }, (_, y) =>
      Array.from({ length: cols }, (_, x) => g.floor[y]?.[x] ?? 1),
    );
    const walls = Array.from({ length: rows }, (_, y) =>
      Array.from({ length: cols }, (_, x) => (key(x, y) === open ? 0 : (g.walls[y]?.[x] ?? 0))),
    );
    map.layers = { floor, walls };
    map.objects = [
      ...g.objects.map((o) =>
        wall(o) && key(o.col, o.row) === open ? { ...o, type: "meeting_door" } : o,
      ),
      ...additions,
    ];
  }
  g = projectMeetingMap(map);
  const space = spaceFor(g, b, "meeting-annex-v1", component(g, start));
  if (!space) invalid("증축 회의실의 접근 경로 검증에 실패했습니다");
  const openAnnex = (x: number, y: number) =>
    insideMeetingSpace(b, x, y) || corridor.has(key(x, y));
  space.generatedAnnexWalls = additions
    .filter((o) => o.type === "room_wall_h")
    .map((o) => {
      const horizontal = openAnnex(o.col, o.row - 1) || openAnnex(o.col, o.row + 1);
      const vertical = openAnnex(o.col - 1, o.row) || openAnnex(o.col + 1, o.row);
      const diagonal = [-1, 1].some((dx) =>
        [-1, 1].some((dy) => openAnnex(o.col + dx, o.row + dy)),
      );
      return {
        id: generatedIds.get(o.id)!,
        col: o.col,
        row: o.row,
        type: "room_wall_h",
        display:
          (horizontal && vertical) || (!horizontal && !vertical && diagonal)
            ? "corner"
            : horizontal
              ? "horizontal"
              : vertical
                ? "vertical"
                : "hidden",
      };
    });
  map.meetingSpace = space;
  return { mapData: map, meetingSpace: space };
}
