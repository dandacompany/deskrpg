import {
  PUBLISHING_SIZE,
  PUBLISHING_ENTRANCE,
  PUBLISHING_ZONES,
  furnishPublishing,
} from "./publishing-layout";
import { officeFootprintLayers } from "./office-layout-modules";
import {
  TRADING_SIZE,
  TRADING_ENTRANCE,
  TRADING_ZONES,
  tradingFloorCell,
  furnishTrading,
} from "./trading-layout";
import {
  TECH_STARTUP_ENTRANCE,
  TECH_STARTUP_SIZE,
  TECH_STARTUP_ZONES,
  furnishTechStartup,
} from "./tech-startup-layout";
import { furnishOfficeRooms, OFFICE_ROOMS } from "./office-room-layout";
import {
  CREATIVE_STUDIO_SIZE,
  CREATIVE_STUDIO_ZONES,
  furnishCreativeStudio,
  type CreativeStudioPlacement,
} from "./creative-studio-layout";
import type { TiledMap, TiledObject, TiledProperty } from "../../lib/tiled-map";
import { getObjectDimensions } from "../../lib/object-types";
import { normalizeLocale } from "../../lib/i18n/server";

/**
 * Server-safe base map factory. The map-editor hook is a Client Module, so its
 * exported helper cannot be invoked by the channel GET route during a lazy
 * official-environment upgrade in a production Next.js build.
 */
function createOfficeBaseMap(
  name: string,
  width: number,
  height: number,
  tileSize: number,
): TiledMap {
  const empty = new Array(width * height).fill(0);
  const tileLayer = (id: number, layerName: string, depth: number, opacity = 1) => ({
    id,
    name: layerName,
    type: "tilelayer" as const,
    width,
    height,
    x: 0,
    y: 0,
    opacity,
    visible: true,
    data: [...empty],
    properties: [{ name: "depth", type: "int", value: depth }],
  });

  return {
    compressionlevel: -1,
    width,
    height,
    tilewidth: tileSize,
    tileheight: tileSize,
    orientation: "orthogonal",
    renderorder: "right-down",
    infinite: false,
    type: "map",
    version: "1.10",
    tiledversion: "1.11.2",
    nextlayerid: 7,
    nextobjectid: 2,
    tilesets: [],
    layers: [
      tileLayer(1, "Floor", 0),
      tileLayer(2, "Walls", 1),
      tileLayer(3, "Foreground", 10000),
      tileLayer(4, "Collision", -1, 0.7),
      {
        id: 5,
        name: "Objects",
        type: "objectgroup",
        x: 0,
        y: 0,
        opacity: 1,
        visible: true,
        draworder: "topdown",
        objects: [
          {
            id: 1,
            name: "spawn",
            type: "spawn",
            x: Math.floor(width / 2) * tileSize,
            y: Math.floor(height / 2) * tileSize,
            width: tileSize,
            height: tileSize,
            visible: true,
          },
        ],
        properties: [{ name: "depth", type: "string", value: "y-sort" }],
      },
    ],
  };
}

export const OFFICE_ENVIRONMENTS = Object.freeze([
  Object.freeze({
    id: "trading",
    nameKo: "종합상사",
    nameEn: "Trading company",
    descriptionKo: "책상 섬과 임원석, 회의 공간이 어우러진 정통 오피스",
    descriptionEn: "A classic office with desk islands, a leader's desk and meeting space.",
    color: "#8F7152",
  }),
  Object.freeze({
    id: "agency",
    nameKo: "크리에이티브 스튜디오",
    nameEn: "Creative studio",
    descriptionKo: "촬영, 아이데이션, 프로덕션과 라운지가 이어지는 열린 스튜디오",
    descriptionEn: "An open studio linking photo, ideation, production and lounge zones.",
    color: "#C17B64",
  }),
  Object.freeze({
    id: "tech",
    nameKo: "테크 스타트업",
    nameEn: "Tech startup",
    descriptionKo: "집중 업무석과 스프린트 회의 공간을 갖춘 개발팀 오피스",
    descriptionEn: "A developer office with focused workstations and sprint meeting spaces.",
    color: "#648C86",
  }),
  Object.freeze({
    id: "executive",
    nameKo: "임원 오피스",
    nameEn: "Executive office",
    descriptionKo: "월넛 업무석, 라운드 미팅과 응접 라운지가 있는 임원실",
    descriptionEn:
      "A walnut executive suite with a round meeting table and a warm reception lounge.",
    color: "#596B61",
  }),
  Object.freeze({
    id: "publishing",
    nameKo: "출판사",
    nameEn: "Publishing house",
    descriptionKo: "서가 사이 편집석과 원고를 함께 읽는 테이블",
    descriptionEn:
      "Editorial desks among bookshelves, with tables for reading manuscripts together.",
    color: "#AA8659",
  }),
] as const);

export type OfficeEnvironmentId = (typeof OFFICE_ENVIRONMENTS)[number]["id"];

type OfficeEnvironment = (typeof OFFICE_ENVIRONMENTS)[number];
export type EnvironmentLabel = { name: string; description: string };

/** ja/zh display labels. ko and en live on the environment itself. */
const ENVIRONMENT_LABELS: Record<"ja" | "zh", Record<OfficeEnvironmentId, EnvironmentLabel>> = {
  ja: {
    trading: {
      name: "総合商社",
      description: "デスクの島と役員席、会議スペースが調和した正統派オフィス",
    },
    agency: {
      name: "クリエイティブスタジオ",
      description: "撮影、アイデア出し、制作、ラウンジがつながる開放的なスタジオ",
    },
    tech: {
      name: "テックスタートアップ",
      description: "集中できる作業席とスプリント会議スペースを備えた開発チームのオフィス",
    },
    executive: {
      name: "役員オフィス",
      description: "ウォールナットの執務席、ラウンドミーティングと応接ラウンジのある役員室",
    },
    publishing: {
      name: "出版社",
      description: "書架の間の編集席と、原稿を一緒に読むテーブル",
    },
  },
  zh: {
    trading: { name: "综合商社", description: "办公桌岛、主管席与会议空间相融合的经典办公室" },
    agency: { name: "创意工作室", description: "拍摄、创意、制作与休息区相连的开放式工作室" },
    tech: { name: "科技初创公司", description: "配有专注工位与冲刺会议空间的开发团队办公室" },
    executive: {
      name: "高管办公室",
      description: "设有胡桃木办公桌、圆桌会议与接待休息区的高管室",
    },
    publishing: { name: "出版社", description: "书架间的编辑席与一起读稿的长桌" },
  },
};

/** The only way to pick an environment's display name and description. Unknown locales fall back to English. */
export function environmentLabel(
  environment: OfficeEnvironment,
  locale: string | null | undefined,
): EnvironmentLabel {
  const lang = normalizeLocale(locale);
  if (lang === "ko") return { name: environment.nameKo, description: environment.descriptionKo };
  if (lang === "en") return { name: environment.nameEn, description: environment.descriptionEn };
  return ENVIRONMENT_LABELS[lang][environment.id];
}

export const CREATIVE_STUDIO_ENTRANCE = Object.freeze({
  fromCol: 21,
  toCol: 25,
  row: 25,
  spawnCol: 23,
  spawnRow: 23,
} as const);

/** Fresh, deterministic standard Tiled maps. Calling this never edits an existing project. */
export function buildOfficeEnvironment(id: OfficeEnvironmentId): TiledMap {
  const environment = OFFICE_ENVIRONMENTS.find((entry) => entry.id === id);
  if (!environment) throw new Error(`Unknown office environment: ${id}`);
  const cols =
    id === "agency"
      ? CREATIVE_STUDIO_SIZE.cols
      : id === "executive"
        ? 18
        : id === "tech"
          ? TECH_STARTUP_SIZE.cols
          : id === "trading"
            ? TRADING_SIZE.cols
            : PUBLISHING_SIZE.cols;
  const rows =
    id === "agency"
      ? CREATIVE_STUDIO_SIZE.rows
      : id === "executive"
        ? 18
        : id === "tech"
          ? TECH_STARTUP_SIZE.rows
          : id === "trading"
            ? TRADING_SIZE.rows
            : PUBLISHING_SIZE.rows;
  const entrance =
    id === "agency"
      ? CREATIVE_STUDIO_ENTRANCE.spawnCol
      : id === "tech"
        ? TECH_STARTUP_ENTRANCE.spawnCol
        : id === "trading"
          ? TRADING_ENTRANCE.spawnCol
          : id === "publishing"
            ? PUBLISHING_ENTRANCE.spawnCol
            : Math.floor(cols / 2);
  const map = createOfficeBaseMap(environment.nameEn, cols, rows, 32);
  const layer = map.layers.find((entry) => entry.name === "Objects")!;
  const objects: TiledObject[] = [];
  const add = (type: string, col: number, row: number, placement: CreativeStudioPlacement = {}) => {
    const size = getObjectDimensions(type, placement.direction);
    const properties: TiledProperty[] = [];
    if (placement.direction)
      properties.push({ name: "direction", type: "string", value: placement.direction });
    if (placement.variant)
      properties.push({ name: "variant", type: "string", value: placement.variant });
    if (placement.destinationTags)
      properties.push({
        name: "destinationTags",
        type: "string",
        value: JSON.stringify(placement.destinationTags),
      });
    objects.push({
      id: map.nextobjectid++,
      name: type,
      type,
      x: col * 32,
      y: row * 32,
      width: size.width * 32,
      height: size.height * 32,
      visible: true,
      ...(properties.length ? { properties } : {}),
    });
  };
  for (let x = 0; x < cols; x++) {
    add("cubicle_wall", x, 0, id === "trading" ? { variant: "trading-perimeter" } : {});
    const atEntrance =
      id === "agency"
        ? x >= CREATIVE_STUDIO_ENTRANCE.fromCol && x <= CREATIVE_STUDIO_ENTRANCE.toCol
        : id === "tech"
          ? x >= TECH_STARTUP_ENTRANCE.fromCol && x <= TECH_STARTUP_ENTRANCE.toCol
          : id === "trading"
            ? x >= TRADING_ENTRANCE.fromCol && x <= TRADING_ENTRANCE.toCol
            : Math.abs(x - entrance) <= 1;
    if (!atEntrance && (id !== "trading" || tradingFloorCell(x, rows - 1)))
      add("cubicle_wall", x, rows - 1, id === "trading" ? { variant: "trading-perimeter" } : {});
  }
  for (let y = 1; y < rows - 1; y++) {
    add("cubicle_wall", 0, y, id === "trading" ? { variant: "trading-perimeter" } : {});
    add("cubicle_wall", cols - 1, y, id === "trading" ? { variant: "trading-perimeter" } : {});
  }
  if (id === "trading") {
    const floor = map.layers.find((l) => l.name === "Floor")!;
    const collision = map.layers.find((l) => l.name === "Collision")!;
    const footprint = officeFootprintLayers(cols, rows, tradingFloorCell);
    floor.data = footprint.floor;
    collision.data = footprint.collision;
    for (let y = 19; y < rows - 1; y++) {
      add("cubicle_wall", 17, y, { variant: "trading-perimeter" });
      add("cubicle_wall", 26, y, { variant: "trading-perimeter" });
    }
    for (let x = 18; x < 26; x++) add("cubicle_wall", x, 18, { variant: "trading-perimeter" });
    furnishTrading(add);
  } else if (id === "agency") furnishCreativeStudio(add);
  else if (id === "tech") furnishTechStartup(add);
  else if (id === "publishing") furnishPublishing(add);
  else furnishOfficeRooms(id, (type, x, y, direction) => add(type, x, y, { direction }));
  if (id !== "agency" && id !== "tech" && id !== "trading" && id !== "publishing")
    for (const x of [1, cols - 2])
      for (const y of [1, rows - 2]) {
        if (!objects.some((object) => object.x === x * 32 && object.y === y * 32))
          add("plant", x, y);
      }
  if (id === "executive") {
    for (const object of objects) {
      if (["office_sofa", "office_armchair"].includes(object.type)) {
        object.properties = [
          ...(object.properties || []),
          { name: "variant", type: "string", value: "executive-lounge" },
        ];
      }
    }
  }
  add(
    "spawn",
    entrance,
    id === "agency"
      ? CREATIVE_STUDIO_ENTRANCE.spawnRow
      : id === "tech"
        ? TECH_STARTUP_ENTRANCE.spawnRow
        : id === "trading"
          ? TRADING_ENTRANCE.spawnRow
          : rows - 3,
  );
  layer.objects = objects;
  return tagEnvironment(map, id);
}

function tagEnvironment(map: TiledMap, id: OfficeEnvironmentId): TiledMap {
  const layer = map.layers.find((entry) => entry.name === "Objects")!;
  layer.properties = [
    ...(layer.properties || []),
    { name: "officeEnvironment", type: "string", value: id },
    ...[
      {
        name: "ambientZones",
        type: "string",
        value: JSON.stringify(
          id === "agency"
            ? CREATIVE_STUDIO_ZONES
            : id === "tech"
              ? TECH_STARTUP_ZONES
              : id === "trading"
                ? TRADING_ZONES
                : id === "publishing"
                  ? PUBLISHING_ZONES
                  : OFFICE_ROOMS[id].map((room) => ({
                      id: room.id,
                      x: room.x,
                      y: room.z,
                      width: room.width,
                      height: room.depth + 1,
                      roaming: room.id !== "ceo",
                    })),
        ),
      },
    ],
    {
      name: "officeEnvironmentVersion",
      type: "int",
      value:
        id === "agency"
          ? 5
          : id === "executive"
            ? 5
            : id === "tech" || id === "trading" || id === "publishing"
              ? 3
              : 2,
    },
  ];
  return map;
}
