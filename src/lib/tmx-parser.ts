// src/lib/tmx-parser.ts — Convert Tiled TMX (XML) to Tiled JSON format

/**
 * Parse a TMX XML string and convert to Tiled JSON format.
 * Handles tile layers (CSV data), object groups, and embedded/external tilesets.
 */
export function tmxToJson(tmxText: string): Record<string, unknown> {
  const attr = (el: string, name: string): string | null => {
    const match = el.match(new RegExp(`${name}="([^"]*)"`));
    return match ? match[1] : null;
  };
  const attrInt = (el: string, name: string, def = 0): number => {
    const v = attr(el, name);
    return v ? parseInt(v, 10) : def;
  };

  const mapMatch = tmxText.match(/<map\s[^>]*>/);
  if (!mapMatch) throw new Error("Invalid TMX: no <map> element found");
  const mapEl = mapMatch[0];

  const width = attrInt(mapEl, "width", 15);
  const height = attrInt(mapEl, "height", 11);
  const tilewidth = attrInt(mapEl, "tilewidth", 32);
  const tileheight = attrInt(mapEl, "tileheight", 32);
  const orientation = attr(mapEl, "orientation") || "orthogonal";
  const renderorder = attr(mapEl, "renderorder") || "right-down";
  const tiledversion = attr(mapEl, "tiledversion") || "1.11.0";
  const version = attr(mapEl, "version") || "1.10";

  // Parse tilesets
  const tilesets: Record<string, unknown>[] = [];
  const tilesetRegex = /<tileset\s[^>]*(?:\/>|>[\s\S]*?<\/tileset>)/g;
  let tsMatch;
  while ((tsMatch = tilesetRegex.exec(tmxText)) !== null) {
    const tsEl = tsMatch[0];
    const firstgid = attrInt(tsEl, "firstgid", 1);
    const source = attr(tsEl, "source");

    if (source && !tsEl.includes("<image")) {
      // External tileset reference
      tilesets.push({
        firstgid,
        name: source.replace(/\.tsx$/, ""),
        tilewidth,
        tileheight,
        tilecount: 16,
        columns: 16,
        image: source.replace(/\.tsx$/, ".png"),
        imagewidth: 512,
        imageheight: 32,
      });
    } else {
      // Embedded tileset
      const ts: Record<string, unknown> = {
        firstgid,
        name: attr(tsEl, "name") || "tileset",
        tilewidth: attrInt(tsEl, "tilewidth", tilewidth),
        tileheight: attrInt(tsEl, "tileheight", tileheight),
        tilecount: attrInt(tsEl, "tilecount", 0),
        columns: attrInt(tsEl, "columns", 0),
      };

      const imgMatch = tsEl.match(/<image\s[^>]*\/?>/);
      if (imgMatch) {
        ts.image = attr(imgMatch[0], "source") || "";
        ts.imagewidth = attrInt(imgMatch[0], "width", 0);
        ts.imageheight = attrInt(imgMatch[0], "height", 0);
      }

      // Tile properties
      const tiles: Record<string, unknown>[] = [];
      const tileRegex = /<tile\s[^>]*>[\s\S]*?<\/tile>/g;
      let tileMatch;
      while ((tileMatch = tileRegex.exec(tsEl)) !== null) {
        const tEl = tileMatch[0];
        const tileId = attrInt(tEl, "id", 0);
        const props: Record<string, unknown>[] = [];
        const propRegex = /<property\s[^>]*\/?>/g;
        let propMatch;
        while ((propMatch = propRegex.exec(tEl)) !== null) {
          const pEl = propMatch[0];
          const pType = attr(pEl, "type") || "string";
          const pValue = attr(pEl, "value") || "";
          props.push({
            name: attr(pEl, "name") || "",
            type: pType,
            value: pType === "bool" ? pValue === "true" : pValue,
          });
        }
        if (props.length > 0) tiles.push({ id: tileId, properties: props });
      }
      if (tiles.length > 0) ts.tiles = tiles;

      tilesets.push(ts);
    }
  }

  // Parse layers
  const layers: Record<string, unknown>[] = [];
  let nextLayerId = 1;

  // Tile layers
  const layerRegex = /<layer\s[^>]*>[\s\S]*?<\/layer>/g;
  let layerMatch;
  while ((layerMatch = layerRegex.exec(tmxText)) !== null) {
    const lEl = layerMatch[0];
    const layerName = attr(lEl, "name") || `layer${nextLayerId}`;
    const lWidth = attrInt(lEl, "width", width);
    const lHeight = attrInt(lEl, "height", height);

    const dataMatch = lEl.match(/<data\s[^>]*>([\s\S]*?)<\/data>/);
    let data: number[] = [];
    if (dataMatch) {
      const encoding = attr(dataMatch[0], "encoding");
      if (encoding === "csv" || !encoding) {
        data = dataMatch[1].trim().split(/[,\s]+/).filter(Boolean).map(Number);
      } else if (encoding === "base64") {
        const compressed = attr(dataMatch[0], "compression");
        if (compressed) {
          throw new Error(`TMX compression "${compressed}" not supported. Save with CSV encoding.`);
        }
        const b64 = dataMatch[1].trim();
        const binary = Buffer.from(b64, "base64");
        data = [];
        for (let i = 0; i < binary.length; i += 4) {
          data.push(binary[i] | (binary[i + 1] << 8) | (binary[i + 2] << 16) | (binary[i + 3] << 24));
        }
      }
    }

    layers.push({
      id: nextLayerId++,
      name: layerName,
      type: "tilelayer",
      width: lWidth,
      height: lHeight,
      x: 0, y: 0, opacity: 1, visible: true,
      data,
    });
  }

  // Object groups
  const objGroupRegex = /<objectgroup\s[^>]*>[\s\S]*?<\/objectgroup>/g;
  let ogMatch;
  while ((ogMatch = objGroupRegex.exec(tmxText)) !== null) {
    const ogEl = ogMatch[0];
    const groupName = attr(ogEl, "name") || "objects";

    const objects: Record<string, unknown>[] = [];
    const objRegex = /<object\s[^>]*(?:\/>|>[\s\S]*?<\/object>)/g;
    let objMatch;
    let nextObjId = 1;
    while ((objMatch = objRegex.exec(ogEl)) !== null) {
      const oEl = objMatch[0];
      const obj: Record<string, unknown> = {
        id: attrInt(oEl, "id", nextObjId++),
        name: attr(oEl, "name") || "",
        type: attr(oEl, "type") || attr(oEl, "class") || "",
        x: attrInt(oEl, "x", 0),
        y: attrInt(oEl, "y", 0),
        width: attrInt(oEl, "width", 0),
        height: attrInt(oEl, "height", 0),
        visible: true,
      };

      if (oEl.includes("<point") || (obj.width === 0 && obj.height === 0)) {
        obj.point = true;
      }

      const props: Record<string, unknown>[] = [];
      const propRegex2 = /<property\s[^>]*\/?>/g;
      let pm;
      while ((pm = propRegex2.exec(oEl)) !== null) {
        const pType = attr(pm[0], "type") || "string";
        const pValue = attr(pm[0], "value") || "";
        props.push({
          name: attr(pm[0], "name") || "",
          type: pType,
          value: pType === "bool" ? pValue === "true" : pValue,
        });
      }
      if (props.length > 0) obj.properties = props;

      objects.push(obj);
    }

    layers.push({
      id: nextLayerId++,
      name: groupName,
      type: "objectgroup",
      x: 0, y: 0, opacity: 1, visible: true,
      objects,
    });
  }

  return {
    compressionlevel: -1,
    width, height, tilewidth, tileheight,
    infinite: false, orientation, renderorder,
    type: "map", version, tiledversion,
    nextlayerid: nextLayerId,
    nextobjectid: 1,
    tilesets, layers,
  };
}
