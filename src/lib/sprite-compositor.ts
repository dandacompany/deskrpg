// ---------------------------------------------------------------------------
// Sprite Compositor — composites LPC layers onto a single canvas
// ---------------------------------------------------------------------------

import {
  CharacterAppearance,
  LegacyCharacterAppearance,
  normalizeAppearance,
  findItem,
} from "./lpc-registry";

// Walk-only spritesheet dimensions
export const FRAME_WIDTH = 64;
export const FRAME_HEIGHT = 64;
export const WALK_COLS = 9;
export const WALK_ROWS = 4;
export const WALK_SHEET_WIDTH = 576; // 9 * 64
export const WALK_SHEET_HEIGHT = 256; // 4 * 64

// Direction row indices (walk-only sheets)
// Row 0 = up, Row 1 = left, Row 2 = down, Row 3 = right

/**
 * Loads an image from the given `src` URL and resolves when ready.
 */
export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = (_e) => reject(new Error(`Failed to load image: ${src}`));
    img.src = src;
  });
}

/** A resolved layer with its path and z-position for sorting. */
interface ResolvedLayer {
  path: string;
  zPos: number;
}

/**
 * Returns an ordered array of spritesheet paths for the given appearance,
 * sorted by zPos (lowest first = drawn first = bottom layer).
 */
export function getLayerPaths(
  rawAppearance: CharacterAppearance | LegacyCharacterAppearance,
): string[] {
  const appearance = normalizeAppearance(rawAppearance);
  const bt = appearance.bodyType;
  const resolved: ResolvedLayer[] = [];

  // Collect layers from all selected items
  for (const [_catId, selection] of Object.entries(appearance.layers)) {
    if (!selection) continue;

    const item = findItem(selection.itemKey);
    if (!item) continue;

    for (const [_layerName, layerDef] of Object.entries(item.layers)) {
      let basePath = layerDef.paths[bt];
      if (!basePath) continue;

      // Resolve template variables in LPC paths
      // ${head} → "adult" (age group), ${expression} → "default" (eye expression)
      basePath = basePath.replace(/\$\{head\}/g, "adult").replace(/\$\{expression\}/g, "default");

      // eye_color special case: the actual downloaded files are at eyes/default/walk/
      // but the registry says eyes/human/adult/default
      if (selection.itemKey === "eye_color") {
        basePath = "eyes/default";
      }

      resolved.push({
        path: `/assets/spritesheets/${basePath}/walk/${selection.variant}.png`,
        zPos: layerDef.zPos,
      });
    }
  }

  // Auto-include head layer matching body skin color
  const bodySelection = appearance.layers.body;
  if (bodySelection) {
    const headPath = `/assets/spritesheets/head/human/${bt}/walk/${bodySelection.variant}.png`;
    // Head zPos is typically around 40-50 — use 45 as default
    resolved.push({ path: headPath, zPos: 45 });
  }

  // Sort by zPos ascending (bottom layers first)
  resolved.sort((a, b) => a.zPos - b.zPos);

  return resolved.map((r) => r.path);
}

/**
 * Composites all appearance layers onto the provided canvas element.
 * The canvas is resized to 576x256 (walk-only sheet) and cleared before drawing.
 */
export async function compositeCharacter(
  canvas: HTMLCanvasElement,
  appearance: CharacterAppearance | LegacyCharacterAppearance,
): Promise<void> {
  canvas.width = WALK_SHEET_WIDTH;
  canvas.height = WALK_SHEET_HEIGHT;

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Cannot get 2d context from canvas");

  ctx.clearRect(0, 0, WALK_SHEET_WIDTH, WALK_SHEET_HEIGHT);
  ctx.imageSmoothingEnabled = false;

  const paths = getLayerPaths(appearance);

  // Load all images, silently skip any that fail (404, etc.)
  const results = await Promise.allSettled(paths.map(loadImage));

  for (const result of results) {
    if (result.status === "fulfilled") {
      ctx.drawImage(result.value, 0, 0, WALK_SHEET_WIDTH, WALK_SHEET_HEIGHT);
    }
  }
}
