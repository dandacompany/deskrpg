import JSZip from 'jszip';
import type { TiledMap } from '@/components/map-editor/hooks/useMapEditor';

export async function buildProjectZip(
  mapData: TiledMap,
  tilesetImages: Record<number, { img: HTMLImageElement; name: string }>,
  projectName: string,
  previewDataUrl?: string,
): Promise<Blob> {
  const zip = new JSZip();

  // Normalize tileset paths and collect images
  const tmjCopy = JSON.parse(JSON.stringify(mapData)) as TiledMap;

  for (const ts of tmjCopy.tilesets) {
    const tsName = (ts.name || 'tileset').replace(/[^a-zA-Z0-9_-]/g, '_') + '.png';
    ts.image = 'tilesets/' + tsName;

    const imgInfo = tilesetImages[ts.firstgid];
    if (imgInfo?.img) {
      const canvas = document.createElement('canvas');
      canvas.width = imgInfo.img.naturalWidth || imgInfo.img.width;
      canvas.height = imgInfo.img.naturalHeight || imgInfo.img.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(imgInfo.img, 0, 0);
      const blob = await new Promise<Blob>((resolve) => {
        canvas.toBlob((b) => resolve(b!), 'image/png');
      });
      zip.file('tilesets/' + tsName, blob);
    }
  }

  // TMJ
  zip.file('maps/map.tmj', JSON.stringify(tmjCopy, null, 2));

  // project.json
  zip.file('project.json', JSON.stringify({
    name: projectName,
    created: new Date().toISOString(),
    modified: new Date().toISOString(),
    tileSize: mapData.tilewidth,
    mapFile: 'maps/map.tmj',
  }));

  // Preview
  if (previewDataUrl) {
    const resp = await fetch(previewDataUrl);
    const blob = await resp.blob();
    zip.file('preview.png', blob);
  }

  return zip.generateAsync({ type: 'blob' });
}

export async function loadProjectZip(file: File): Promise<{
  mapData: TiledMap;
  tilesetDataUrls: Record<string, string>;
  projectName: string;
}> {
  const zip = await JSZip.loadAsync(file);

  // Find TMJ
  let tmjContent: string | null = null;
  let projectName = file.name.replace(/\.zip$/i, '');

  // Check project.json
  const projFile = zip.file('project.json');
  if (projFile) {
    const projJson = JSON.parse(await projFile.async('string'));
    projectName = projJson.name || projectName;
    const mapFile = zip.file(projJson.mapFile);
    if (mapFile) tmjContent = await mapFile.async('string');
  }

  // Fallback: find any .tmj file
  if (!tmjContent) {
    for (const [path, entry] of Object.entries(zip.files)) {
      if (path.endsWith('.tmj') || path.endsWith('.json')) {
        const content = await entry.async('string');
        try {
          const parsed = JSON.parse(content);
          if (parsed.layers && parsed.tilesets) {
            tmjContent = content;
            break;
          }
        } catch { /* not valid JSON */ }
      }
    }
  }

  if (!tmjContent) throw new Error('No valid TMJ file found in ZIP');

  const mapData = JSON.parse(tmjContent) as TiledMap;

  // Extract tileset images as data URLs
  const tilesetDataUrls: Record<string, string> = {};
  for (const [path, entry] of Object.entries(zip.files)) {
    if (path.match(/\.(png|jpg|jpeg)$/i) && !entry.dir) {
      const blob = await entry.async('blob');
      tilesetDataUrls[path] = URL.createObjectURL(blob);
      // Also map by filename only
      const filename = path.split('/').pop()!;
      tilesetDataUrls[filename] = tilesetDataUrls[path];
    }
  }

  return { mapData, tilesetDataUrls, projectName };
}
