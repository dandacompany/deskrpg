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
 * Find matching layer index in map by name (case-insensitive)
 */
export function findLayerByName(
  mapLayers: Array<{ name: string }>,
  targetName: string,
): number {
  const lower = targetName.toLowerCase();
  return mapLayers.findIndex((l) => l.name.toLowerCase() === lower);
}
