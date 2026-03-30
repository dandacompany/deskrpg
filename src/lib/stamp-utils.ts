// Types for stamp data from API
export interface StampLayerData {
  name: string;
  type: string;
  depth: number;
  data: number[];
}

export interface StampTilesetData {
  name: string;
  firstgid: number;
  tilewidth: number;
  tileheight: number;
  columns: number;
  tilecount: number;
  image: string; // base64 data URL
}

export interface StampData {
  id: string;
  name: string;
  cols: number;
  rows: number;
  tileWidth: number;
  tileHeight: number;
  layers: StampLayerData[];
  tilesets: StampTilesetData[];
  thumbnail: string | null;
}

// Lightweight version for list display
export interface StampListItem {
  id: string;
  name: string;
  cols: number;
  rows: number;
  thumbnail: string | null;
  layerNames: string[];
}

/**
 * Build GID remap table: stamp GID → map GID
 */
export function buildGidRemapTable(
  stampTilesets: StampTilesetData[],
  mapTilesetFirstgids: Record<string, number>,
): Map<number, number> {
  const remap = new Map<number, number>();
  for (const st of stampTilesets) {
    const mapFirstgid = mapTilesetFirstgids[st.name];
    if (mapFirstgid === undefined) continue;
    const offset = mapFirstgid - st.firstgid;
    for (let i = 0; i < st.tilecount; i++) {
      const stampGid = st.firstgid + i;
      remap.set(stampGid, stampGid + offset);
    }
  }
  return remap;
}

/**
 * Render a single tile from a tileset image to a small canvas and return its pixel hash.
 */
function renderTileToHash(
  img: HTMLImageElement,
  localId: number,
  columns: number,
  tw: number,
  th: number,
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
): string {
  const srcCol = localId % columns;
  const srcRow = Math.floor(localId / columns);
  ctx.clearRect(0, 0, tw, th);
  ctx.drawImage(img, srcCol * tw, srcRow * th, tw, th, 0, 0, tw, th);
  const data = ctx.getImageData(0, 0, tw, th).data;
  // Fast hash: sample every 4th pixel's RGBA
  let hash = '';
  for (let i = 0; i < data.length; i += 16) {
    hash += String.fromCharCode(data[i] & 0xff, data[i + 1] & 0xff, data[i + 2] & 0xff, data[i + 3] & 0xff);
  }
  return hash;
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

/**
 * Build a pixel-matching remap table: stamp GID → map GID.
 * Compares actual tile pixel data instead of relying on tileset names/firstgids.
 */
export function buildPixelMatchRemap(
  stampTilesets: StampTilesetData[],
  stampTilesetImages: Map<number, HTMLImageElement>,
  mapTilesetImages: Record<number, TilesetImageInfo>,
): Map<number, number> {
  const remap = new Map<number, number>();

  // Build hash → mapGid lookup from all map tilesets
  const tw = Object.values(mapTilesetImages)[0]?.tilewidth ?? 32;
  const th = Object.values(mapTilesetImages)[0]?.tileheight ?? 32;
  const canvas = document.createElement('canvas');
  canvas.width = tw;
  canvas.height = th;
  const ctx = canvas.getContext('2d')!;

  const mapHashToGid = new Map<string, number>();
  for (const info of Object.values(mapTilesetImages)) {
    for (let i = 0; i < info.tilecount; i++) {
      const hash = renderTileToHash(info.img, i, info.columns, info.tilewidth, info.tileheight, canvas, ctx);
      // Skip fully transparent tiles
      if (hash.split('').every((c) => c === '\0')) continue;
      mapHashToGid.set(hash, info.firstgid + i);
    }
  }

  // For each stamp tile, compute hash and find matching map GID
  for (const st of stampTilesets) {
    const img = stampTilesetImages.get(st.firstgid);
    if (!img) continue;
    for (let i = 0; i < st.tilecount; i++) {
      const stampGid = st.firstgid + i;
      const hash = renderTileToHash(img, i, st.columns, st.tilewidth, st.tileheight, canvas, ctx);
      const mapGid = mapHashToGid.get(hash);
      if (mapGid !== undefined) {
        remap.set(stampGid, mapGid);
      }
    }
  }

  return remap;
}

/**
 * Find matching layer index in map by name (case-insensitive)
 */
export function findLayerByName(
  mapLayers: Array<{ name: string }>,
  targetName: string,
): number {
  const lower = targetName.toLowerCase();
  return mapLayers.findIndex((l) => l.name.toLowerCase() === lower);
}
