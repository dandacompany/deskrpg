// src/lib/tiled-map.ts — Tiled JSON map types. Even after the map editor was removed, the 3D
// renderer, office-environment builder, and server motion layout still share this shape, so it's kept here as the source of truth.

export interface TiledTileset {
  firstgid: number;
  name: string;
  tilewidth: number;
  tileheight: number;
  tilecount: number;
  columns: number;
  image: string;
  imagewidth: number;
  imageheight: number;
  tiles?: Array<{
    id: number;
    properties?: Array<{ name: string; type: string; value: unknown }>;
    objectgroup?: unknown;
  }>;
}

export interface TiledProperty {
  name: string;
  type: string;
  value: unknown;
}

export interface TiledLayer {
  id: number;
  name: string;
  type: "tilelayer" | "objectgroup";
  width?: number;
  height?: number;
  data?: number[];
  objects?: TiledObject[];
  opacity: number;
  visible: boolean;
  x: number;
  y: number;
  draworder?: string;
  properties?: TiledProperty[];
}

export interface TiledObject {
  properties?: TiledProperty[];
  id: number;
  name: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
}

export interface TiledMap {
  width: number;
  height: number;
  tilewidth: number;
  tileheight: number;
  orientation: string;
  renderorder: string;
  layers: TiledLayer[];
  tilesets: TiledTileset[];
  nextlayerid: number;
  nextobjectid: number;
  infinite: boolean;
  type: string;
  version: string;
  tiledversion: string;
  compressionlevel: number;
}

export interface TileRegion {
  firstgid: number;
  col: number;
  row: number;
  width: number;
  height: number;
  gids: number[][];
}

export interface TilesetImageInfo {
  img: HTMLImageElement;
  firstgid: number;
  columns: number;
  tilewidth: number;
  tileheight: number;
  tilecount: number;
  name: string;
}
