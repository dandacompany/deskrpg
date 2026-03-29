// src/lib/tmx-exporter.ts — Convert TiledMap JSON to TMX XML string

import type { TiledMap, TiledLayer, TiledTileset, TiledObject } from '@/components/map-editor/hooks/useMapEditor';

/** Escape special XML characters in attribute values and text content. */
function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function tilesetToXml(ts: TiledTileset): string {
  const lines: string[] = [];
  lines.push(
    ` <tileset firstgid="${ts.firstgid}" name="${xmlEscape(ts.name)}"` +
    ` tilewidth="${ts.tilewidth}" tileheight="${ts.tileheight}"` +
    ` tilecount="${ts.tilecount}" columns="${ts.columns}">`
  );
  lines.push(
    `  <image source="${xmlEscape(ts.image)}"` +
    ` width="${ts.imagewidth}" height="${ts.imageheight}"/>`
  );
  lines.push(` </tileset>`);
  return lines.join('\n');
}

function objectToXml(obj: TiledObject): string {
  return (
    `   <object id="${obj.id}" name="${xmlEscape(obj.name)}"` +
    ` type="${xmlEscape(obj.type)}"` +
    ` x="${obj.x}" y="${obj.y}"` +
    ` width="${obj.width}" height="${obj.height}"` +
    (obj.visible === false ? ' visible="0"' : '') +
    `/>`
  );
}

function layerToXml(layer: TiledLayer): string {
  const lines: string[] = [];

  if (layer.type === 'tilelayer') {
    lines.push(
      ` <layer id="${layer.id}" name="${xmlEscape(layer.name)}"` +
      ` width="${layer.width ?? 0}" height="${layer.height ?? 0}"` +
      ` opacity="${layer.opacity}"` +
      (layer.visible === false ? ' visible="0"' : '') +
      `>`
    );

    // Properties
    if (layer.properties && layer.properties.length > 0) {
      lines.push(`  <properties>`);
      for (const prop of layer.properties) {
        lines.push(
          `   <property name="${xmlEscape(prop.name)}"` +
          ` type="${xmlEscape(prop.type)}"` +
          ` value="${xmlEscape(String(prop.value))}"/>`
        );
      }
      lines.push(`  </properties>`);
    }

    // CSV data — one row per line for readability
    const data = layer.data ?? [];
    const width = layer.width ?? 0;
    const rows: string[] = [];
    for (let r = 0; r < (layer.height ?? 0); r++) {
      rows.push(data.slice(r * width, r * width + width).join(','));
    }
    const csv = rows.join(',\n   ');
    lines.push(`  <data encoding="csv">`);
    lines.push(`   ${csv}`);
    lines.push(`  </data>`);
    lines.push(` </layer>`);
  } else if (layer.type === 'objectgroup') {
    const draworder = layer.draworder ? ` draworder="${xmlEscape(layer.draworder)}"` : '';
    lines.push(
      ` <objectgroup id="${layer.id}" name="${xmlEscape(layer.name)}"` +
      ` opacity="${layer.opacity}"` +
      (layer.visible === false ? ' visible="0"' : '') +
      draworder +
      `>`
    );

    // Properties
    if (layer.properties && layer.properties.length > 0) {
      lines.push(`  <properties>`);
      for (const prop of layer.properties) {
        lines.push(
          `   <property name="${xmlEscape(prop.name)}"` +
          ` type="${xmlEscape(prop.type)}"` +
          ` value="${xmlEscape(String(prop.value))}"/>`
        );
      }
      lines.push(`  </properties>`);
    }

    for (const obj of layer.objects ?? []) {
      lines.push(objectToXml(obj));
    }
    lines.push(` </objectgroup>`);
  }

  return lines.join('\n');
}

/**
 * Convert a TiledMap JSON object to a TMX XML string.
 * The output is compatible with Tiled Map Editor and DeskRPG.
 */
export function exportTmx(mapData: TiledMap): string {
  const parts: string[] = [];

  // XML declaration
  parts.push(`<?xml version="1.0" encoding="UTF-8"?>`);

  // <map> opening tag
  parts.push(
    `<map version="${xmlEscape(mapData.version)}"` +
    ` tiledversion="${xmlEscape(mapData.tiledversion)}"` +
    ` orientation="${xmlEscape(mapData.orientation)}"` +
    ` renderorder="${xmlEscape(mapData.renderorder)}"` +
    ` width="${mapData.width}" height="${mapData.height}"` +
    ` tilewidth="${mapData.tilewidth}" tileheight="${mapData.tileheight}"` +
    ` infinite="${mapData.infinite ? 1 : 0}"` +
    ` nextlayerid="${mapData.nextlayerid}" nextobjectid="${mapData.nextobjectid}">`
  );

  // Tilesets
  for (const ts of mapData.tilesets) {
    parts.push(tilesetToXml(ts));
  }

  // Layers (tile layers and object groups)
  for (const layer of mapData.layers) {
    parts.push(layerToXml(layer));
  }

  parts.push(`</map>`);

  return parts.join('\n');
}
