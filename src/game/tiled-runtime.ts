/** Fill in a built-in tileset for tools (map editor, validation) that need at least one tileset entry even for the logical tiles of 3D official maps. A pure geometry helper module. */
export function withRuntimeTileset(map: Record<string, unknown>): Record<string, unknown> {
  if (Array.isArray(map.tilesets) && map.tilesets.length > 0) return map;
  return {
    ...map,
    tilesets: [
      {
        firstgid: 1,
        name: "deskrpg-tileset",
        tilewidth: 32,
        tileheight: 32,
        tilecount: 16,
        columns: 16,
        image: "deskrpg-tileset.png",
        imagewidth: 512,
        imageheight: 32,
      },
    ],
  };
}
