"use client";

import { useState, useCallback } from "react";
import {
  CATEGORIES,
  type CharacterAppearance,
  type AppearanceSelection,
  type RegistryCategory,
  findItem,
} from "@/lib/lpc-registry";

const SKINS = ["light", "olive", "bronze", "brown", "black"] as const;

const DEFAULT_LAYERS_MALE: Record<string, AppearanceSelection | null> = {
  body: { itemKey: "body", variant: "light" },
  eye_color: { itemKey: "eye_color", variant: "blue" },
  hair: { itemKey: "hair_bangsshort", variant: "chestnut" },
  clothes: { itemKey: "torso_clothes_tshirt", variant: "blue" },
  legs: { itemKey: "legs_pants", variant: "charcoal" },
  shoes: { itemKey: "feet_boots_basic", variant: "brown" },
};

const DEFAULT_LAYERS_FEMALE: Record<string, AppearanceSelection | null> = {
  body: { itemKey: "body", variant: "light" },
  eye_color: { itemKey: "eye_color", variant: "blue" },
  hair: { itemKey: "hair_bob", variant: "blonde" },
  clothes: { itemKey: "torso_clothes_blouse", variant: "white" },
  legs: { itemKey: "legs_skirts_plain", variant: "navy" },
  shoes: { itemKey: "feet_boots_basic", variant: "brown" },
};

export function getDefaultLayers(bt: string) {
  return bt === "female" ? { ...DEFAULT_LAYERS_FEMALE } : { ...DEFAULT_LAYERS_MALE };
}

export { SKINS };

export function useCharacterAppearance(
  initialBodyType = "male",
  initialLayers?: Record<string, AppearanceSelection | null>,
) {
  const [bodyType, setBodyType] = useState(initialBodyType);
  const [layers, setLayers] = useState<Record<string, AppearanceSelection | null>>(
    () => initialLayers ?? getDefaultLayers(initialBodyType),
  );
  const [activeCategory, setActiveCategory] = useState("");

  const handleBodyTypeChange = useCallback((newBodyType: string, resetToDefault = false) => {
    setBodyType(newBodyType);
    if (resetToDefault) {
      setLayers(getDefaultLayers(newBodyType));
    } else {
      // Clear incompatible items only
      setLayers((prev) => {
        const cleaned = { ...prev };
        for (const [catId, sel] of Object.entries(cleaned)) {
          if (!sel) continue;
          const item = findItem(sel.itemKey);
          if (!item) continue;
          const compatible = Object.values(item.layers).some((l) => l.paths[newBodyType]);
          if (!compatible) cleaned[catId] = null;
        }
        return cleaned;
      });
    }
  }, []);

  const selectItem = useCallback((categoryId: string, itemKey: string, variant: string) => {
    setLayers((prev) => ({ ...prev, [categoryId]: { itemKey, variant } }));
  }, []);

  const clearCategory = useCallback((categoryId: string) => {
    setLayers((prev) => ({ ...prev, [categoryId]: null }));
  }, []);

  const setVariant = useCallback((categoryId: string, variant: string) => {
    setLayers((prev) => {
      const current = prev[categoryId];
      if (!current) return prev;
      return { ...prev, [categoryId]: { ...current, variant } };
    });
  }, []);

  const setSkin = useCallback((variant: string) => {
    setLayers((prev) => ({ ...prev, body: { itemKey: "body", variant } }));
  }, []);

  const isItemCompatible = useCallback(
    (itemKey: string): boolean => {
      const item = findItem(itemKey);
      if (!item) return true;
      return Object.values(item.layers).some((l) => l.paths[bodyType]);
    },
    [bodyType],
  );

  const getItemBodyTypes = useCallback((itemKey: string): string[] => {
    const item = findItem(itemKey);
    if (!item) return [];
    const types = new Set<string>();
    for (const layer of Object.values(item.layers)) {
      for (const bt of Object.keys(layer.paths)) types.add(bt);
    }
    return Array.from(types);
  }, []);

  const compatibleCount = useCallback(
    (cat: RegistryCategory): number =>
      cat.items.filter((item) => isItemCompatible(item.key)).length,
    [isItemCompatible],
  );

  const randomize = useCallback(() => {
    const bt = bodyType;
    const pick = (cat: RegistryCategory) => {
      const compatible = cat.items.filter(
        (item) =>
          !["body_skeleton", "body_zombie"].includes(item.key) &&
          Object.values(item.layers).some((l) => l.paths[bt]),
      );
      if (compatible.length === 0) return null;
      const item = compatible[Math.floor(Math.random() * compatible.length)];
      const variant = item.variants[Math.floor(Math.random() * item.variants.length)];
      return { itemKey: item.key, variant };
    };

    const newLayers: Record<string, AppearanceSelection | null> = {
      body: { itemKey: "body", variant: SKINS[Math.floor(Math.random() * SKINS.length)] },
      eye_color: pick(CATEGORIES.find((c) => c.id === "eye_color")!) || {
        itemKey: "eye_color",
        variant: "blue",
      },
      hair: pick(CATEGORIES.find((c) => c.id === "hair")!),
      clothes: pick(CATEGORIES.find((c) => c.id === "clothes")!),
      legs: pick(CATEGORIES.find((c) => c.id === "legs")!),
      shoes: pick(CATEGORIES.find((c) => c.id === "shoes")!),
    };
    if (Math.random() < 0.3) newLayers.hat = pick(CATEGORIES.find((c) => c.id === "hat")!);
    if (Math.random() < 0.2)
      newLayers.beard = bt === "male" ? pick(CATEGORIES.find((c) => c.id === "beard")!) : null;
    if (Math.random() < 0.15) newLayers.cape = pick(CATEGORIES.find((c) => c.id === "cape")!);
    setLayers(newLayers);
  }, [bodyType]);

  const buildAppearance = useCallback(
    (): CharacterAppearance => ({ bodyType, layers }),
    [bodyType, layers],
  );

  return {
    bodyType,
    setBodyType,
    layers,
    setLayers,
    activeCategory,
    setActiveCategory,
    handleBodyTypeChange,
    selectItem,
    clearCategory,
    setVariant,
    setSkin,
    isItemCompatible,
    getItemBodyTypes,
    compatibleCount,
    randomize,
    buildAppearance,
  };
}
