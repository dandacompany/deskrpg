// ---------------------------------------------------------------------------
// LPC Character Options Registry — dynamic, auto-generated from lpc-registry.json
// ---------------------------------------------------------------------------

import registryData from "@/../public/assets/lpc-registry.json";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LayerPath {
  zPos: number;
  paths: Record<string, string>; // bodyType → spritesheet folder path
}

export interface RegistryItem {
  key: string;
  name: string;
  type: string;
  variants: string[];
  layers: Record<string, LayerPath>;
  matchBodyColor: boolean;
  priority: number | null;
}

export interface RegistryCategory {
  id: string;
  type_name: string;
  label: string;
  priority: number;
  items: RegistryItem[];
}

export interface LpcRegistry {
  bodyTypes: string[];
  categories: RegistryCategory[];
}

/** The character's selected layers (category id → selection or null) */
export interface AppearanceSelection {
  itemKey: string;
  variant: string;
}

export interface CharacterAppearance {
  bodyType: string;
  layers: Record<string, AppearanceSelection | null>;
}

// Legacy format (for backward compatibility with existing DB records)
export interface AppearanceLayer {
  type: string;
  variant: string;
}

export interface LegacyCharacterAppearance {
  bodyType: string;
  body: AppearanceLayer;
  eyes: AppearanceLayer;
  nose: AppearanceLayer | null;
  hair: AppearanceLayer | null;
  torso: AppearanceLayer | null;
  legs: AppearanceLayer | null;
  feet: AppearanceLayer | null;
}

// ---------------------------------------------------------------------------
// Registry data
// ---------------------------------------------------------------------------

export const registry: LpcRegistry = registryData as unknown as LpcRegistry;

export const BODY_TYPES = registry.bodyTypes.map((id) => ({
  id,
  label: id.charAt(0).toUpperCase() + id.slice(1),
}));

export const CATEGORIES = registry.categories;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Find a registry item by its key.
 */
export function findItem(itemKey: string): RegistryItem | undefined {
  for (const cat of CATEGORIES) {
    const item = cat.items.find((i) => i.key === itemKey);
    if (item) return item;
  }
  return undefined;
}

/**
 * Find which category an item belongs to.
 */
export function findCategoryForItem(itemKey: string): RegistryCategory | undefined {
  for (const cat of CATEGORIES) {
    if (cat.items.some((i) => i.key === itemKey)) return cat;
  }
  return undefined;
}

/**
 * Returns the path to a walk-animation spritesheet PNG for a given layer.
 * Looks up the path from the registry.
 */
export function getSpritesheetPath(
  itemKey: string,
  layerName: string,
  bodyType: string,
  variant: string,
): string | null {
  const item = findItem(itemKey);
  if (!item) return null;

  const layer = item.layers[layerName];
  if (!layer) return null;

  const basePath = layer.paths[bodyType];
  if (!basePath) return null;

  return `/assets/spritesheets/${basePath}/walk/${variant}.png`;
}

/**
 * Legacy mapping: converts old category-based key to an item key in the new registry.
 * E.g. category="hair", type="bob" → itemKey="hair_bob"
 *      category="body", type="body" → itemKey="body" (special case)
 *      category="eyes", type="default" → itemKey="eyes_default"
 */
const LEGACY_KEY_MAP: Record<string, Record<string, string>> = {
  body: { body: "body" },
  eyes: { default: "eye_color" },
  nose: { button: "nose_button" },
  hair: {
    bob: "hair_bob",
    longhawk: "hair_longhawk",
    messy1: "hair_messy1",
    pixie: "hair_pixie",
    princess: "hair_princess",
  },
  torso: {
    longsleeve: "torso_longsleeve",
    tunic: "torso_tunic",
  },
  legs: {
    pants: "legs_pants",
    skirt: "legs_skirt",
  },
  feet: {
    shoes: "feet_shoes",
  },
};

/**
 * Detects if an appearance is in legacy format and converts to new format.
 */
export function normalizeAppearance(
  raw: CharacterAppearance | LegacyCharacterAppearance | string,
): CharacterAppearance {
  // SQLite stores JSON as text — parse if needed
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw) as CharacterAppearance | LegacyCharacterAppearance; } catch { raw = {} as CharacterAppearance; }
  }
  // If it has a "layers" key with an object, it's already new format
  if ("layers" in raw && typeof raw.layers === "object" && raw.layers !== null && !("type" in raw.layers)) {
    return raw as CharacterAppearance;
  }

  // Legacy format
  const legacy = raw as LegacyCharacterAppearance;
  const layers: Record<string, AppearanceSelection | null> = {};

  const legacyFields: { field: keyof LegacyCharacterAppearance; cat: string }[] = [
    { field: "body", cat: "body" },
    { field: "eyes", cat: "eyes" },
    { field: "nose", cat: "nose" },
    { field: "hair", cat: "hair" },
    { field: "torso", cat: "torso" },
    { field: "legs", cat: "legs" },
    { field: "feet", cat: "feet" },
  ];

  for (const { field, cat } of legacyFields) {
    const val = legacy[field] as AppearanceLayer | null;
    if (!val) {
      layers[cat] = null;
      continue;
    }
    const mappedKey = LEGACY_KEY_MAP[cat]?.[val.type];
    if (mappedKey) {
      layers[cat] = { itemKey: mappedKey, variant: val.variant };
    } else {
      // Fallback: try category_type pattern
      layers[cat] = { itemKey: `${cat}_${val.type}`, variant: val.variant };
    }
  }

  return { bodyType: legacy.bodyType, layers };
}

/**
 * Validates a CharacterAppearance object (new format).
 * Returns null when valid, or an error string describing the first problem.
 */
export function validateAppearance(
  raw: CharacterAppearance | LegacyCharacterAppearance,
): string | null {
  const appearance = normalizeAppearance(raw);

  // Validate bodyType
  if (!registry.bodyTypes.includes(appearance.bodyType)) {
    return `Invalid bodyType: ${appearance.bodyType}`;
  }

  // Validate each selected layer
  for (const [_catId, selection] of Object.entries(appearance.layers)) {
    if (selection === null) continue;

    const item = findItem(selection.itemKey);
    if (!item) {
      return `Unknown item: ${selection.itemKey}`;
    }
    if (!item.variants.includes(selection.variant)) {
      return `Invalid variant "${selection.variant}" for item "${selection.itemKey}"`;
    }
  }

  // Body is required
  const bodySelection = appearance.layers.body;
  if (!bodySelection) {
    return "Body layer is required";
  }

  return null;
}
