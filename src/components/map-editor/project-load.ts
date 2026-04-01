import type { TiledMap } from "./hooks/useMapEditor";

export function getProjectMapDataForLoad(
  tiledJson: TiledMap,
  linkedTilesets: Array<unknown>,
): TiledMap {
  return {
    ...tiledJson,
    tilesets: linkedTilesets.length > 0 ? [] : (tiledJson.tilesets ?? []),
  };
}
