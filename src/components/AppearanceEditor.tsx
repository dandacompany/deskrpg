"use client";

import type { ReactNode } from "react";
import {
  BODY_TYPES,
  CATEGORIES,
  type AppearanceSelection,
  type RegistryCategory,
} from "@/lib/lpc-registry";
import { useT } from "@/lib/i18n";
import { X } from "lucide-react";
import { SKINS } from "@/hooks/useCharacterAppearance";

// ---------------------------------------------------------------------------
// Category groups (shared)
// ---------------------------------------------------------------------------

interface CategoryGroup {
  labelKey: string;
  ids: string[];
}

const CATEGORY_GROUPS: CategoryGroup[] = [
  { labelKey: "characters.group.eyesFace", ids: ["eye_color", "eyebrows", "nose"] },
  { labelKey: "characters.group.hairFace", ids: ["hair", "beard"] },
  { labelKey: "characters.group.tops", ids: ["clothes", "jacket", "vest", "dress", "overalls"] },
  { labelKey: "characters.group.bottomsShoes", ids: ["legs", "shoes", "socks"] },
  {
    labelKey: "characters.group.accessories",
    ids: ["hat", "belt", "neck", "earrings", "accessory", "gloves"],
  },
  { labelKey: "characters.group.outerwear", ids: ["cape", "shoulders"] },
  { labelKey: "characters.group.fantasy", ids: ["arms", "shield", "weapon", "wings"] },
];

const ESSENTIAL_IDS = CATEGORY_GROUPS.flatMap((g) => g.ids);
const HIDDEN_CATEGORY_IDS = ["body", "eye_color"];

const ALL_CATEGORY_GROUPS: CategoryGroup[] = [
  ...CATEGORY_GROUPS,
  {
    labelKey: "characters.group.other",
    ids: CATEGORIES.map((c) => c.id).filter(
      (id) => !ESSENTIAL_IDS.includes(id) && !HIDDEN_CATEGORY_IDS.includes(id),
    ),
  },
];

// Skin color map
const SKIN_COLORS: Record<string, string> = {
  light: "#f5d0a9",
  olive: "#c8a882",
  bronze: "#a67c5b",
  brown: "#7a5234",
  black: "#4a3020",
};

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface AppearanceEditorProps {
  bodyType: string;
  layers: Record<string, AppearanceSelection | null>;
  activeCategory: string;
  onBodyTypeChange: (bt: string) => void;
  onSkinChange: (variant: string) => void;
  onSelectItem: (catId: string, itemKey: string, variant: string) => void;
  onClearCategory: (catId: string) => void;
  onSetVariant: (catId: string, variant: string) => void;
  onSetActiveCategory: (catId: string) => void;
  isItemCompatible: (itemKey: string) => boolean;
  getItemBodyTypes: (itemKey: string) => string[];
  compatibleCount: (cat: RegistryCategory) => number;
  /** "full" = grouped categories + drawer (player create), "compact" = inline (NPC modal) */
  variant?: "full" | "compact";
  /** Slot rendered between skin selector and categories (e.g. presets, random button) */
  presetsSlot?: ReactNode;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function AppearanceEditor({
  bodyType,
  layers,
  activeCategory,
  onBodyTypeChange,
  onSkinChange,
  onSelectItem,
  onClearCategory,
  onSetVariant,
  onSetActiveCategory,
  isItemCompatible,
  getItemBodyTypes,
  compatibleCount,
  variant = "full",
  presetsSlot,
}: AppearanceEditorProps) {
  const t = useT();
  const activeCat = CATEGORIES.find((c) => c.id === activeCategory);
  const currentSelection = layers[activeCategory];

  if (variant === "compact") {
    return (
      <CompactEditor
        {...{
          bodyType,
          layers,
          activeCategory,
          activeCat,
          currentSelection,
          onBodyTypeChange,
          onSkinChange,
          onSelectItem,
          onClearCategory,
          onSetVariant,
          onSetActiveCategory,
          isItemCompatible,
          compatibleCount,
          presetsSlot,
        }}
      />
    );
  }

  // --- Full variant (player creation page) ---
  return (
    <>
      {/* Left sidebar */}
      <div className="min-w-60 w-max bg-gray-800 p-4 flex flex-col gap-4 overflow-y-auto">
        {/* Body type toggle */}
        <div>
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
            {t("characters.bodyType")}
          </h3>
          <div className="flex gap-1.5">
            {BODY_TYPES.map((bt) => (
              <button
                key={bt.id}
                onClick={() => onBodyTypeChange(bt.id)}
                className={`flex-1 px-3 py-2 rounded text-sm font-medium ${
                  bodyType === bt.id
                    ? "bg-indigo-600 text-white"
                    : "bg-gray-700 text-gray-300 hover:bg-gray-600"
                }`}
              >
                {bt.id === "male" ? t("characters.male") : t("characters.female")}
              </button>
            ))}
          </div>
        </div>

        {/* Skin color */}
        <div>
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
            {t("characters.skin")}
          </h3>
          <div className="flex gap-1.5">
            {SKINS.map((v) => (
              <button
                key={v}
                onClick={() => onSkinChange(v)}
                className={`flex-1 py-3 rounded ${
                  layers.body?.variant === v
                    ? "ring-2 ring-indigo-500"
                    : "hover:ring-1 hover:ring-gray-500"
                }`}
                style={{ background: SKIN_COLORS[v] }}
                title={v}
              />
            ))}
          </div>
        </div>

        {/* Presets slot (random button, outfit presets, etc.) */}
        {presetsSlot}

        {/* Grouped category tabs */}
        <div className="flex flex-col gap-3">
          {ALL_CATEGORY_GROUPS.map((group) => {
            const groupCats = group.ids
              .filter((id) => !HIDDEN_CATEGORY_IDS.includes(id))
              .map((id) => CATEGORIES.find((c) => c.id === id))
              .filter((cat): cat is RegistryCategory => !!cat)
              .filter((cat) => compatibleCount(cat) > 0);
            if (groupCats.length === 0) return null;
            return (
              <div key={group.labelKey}>
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">
                  {t(group.labelKey)}
                </h3>
                <div className="flex flex-col [@media(max-height:800px)]:grid [@media(max-height:800px)]:grid-cols-2 gap-1">
                  {groupCats.map((cat) => {
                    const count = compatibleCount(cat);
                    const isActive = activeCategory === cat.id;
                    return (
                      <button
                        key={cat.id}
                        onClick={() => onSetActiveCategory(isActive ? "" : cat.id)}
                        className={`text-left px-3 py-2 rounded text-sm ${
                          isActive
                            ? "bg-indigo-600 text-white"
                            : "bg-gray-700/60 text-gray-300 hover:bg-gray-600"
                        }`}
                      >
                        {t("characters.cat." + cat.id) || cat.label}
                        {layers[cat.id] && <span className="ml-1 text-indigo-300">*</span>}
                        {!isActive && <span className="ml-1 text-gray-500">{count}</span>}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Drawer — item & variant selection */}
      {activeCat && !HIDDEN_CATEGORY_IDS.includes(activeCategory) && (
        <ItemDrawer
          activeCat={activeCat}
          activeCategory={activeCategory}
          currentSelection={currentSelection}
          layers={layers}
          onSelectItem={onSelectItem}
          onClearCategory={onClearCategory}
          onSetVariant={onSetVariant}
          onClose={() => onSetActiveCategory("")}
          isItemCompatible={isItemCompatible}
          getItemBodyTypes={getItemBodyTypes}
          variant="full"
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Compact variant (NPC modal)
// ---------------------------------------------------------------------------

function CompactEditor({
  bodyType,
  layers,
  activeCategory,
  activeCat,
  currentSelection,
  onBodyTypeChange,
  onSkinChange,
  onSelectItem,
  onClearCategory,
  onSetVariant,
  onSetActiveCategory,
  isItemCompatible,
  compatibleCount,
  presetsSlot,
}: {
  bodyType: string;
  layers: Record<string, AppearanceSelection | null>;
  activeCategory: string;
  activeCat: RegistryCategory | undefined;
  currentSelection: AppearanceSelection | null | undefined;
  onBodyTypeChange: (bt: string) => void;
  onSkinChange: (variant: string) => void;
  onSelectItem: (catId: string, itemKey: string, variant: string) => void;
  onClearCategory: (catId: string) => void;
  onSetVariant: (catId: string, variant: string) => void;
  onSetActiveCategory: (catId: string) => void;
  isItemCompatible: (itemKey: string) => boolean;
  compatibleCount: (cat: RegistryCategory) => number;
  presetsSlot?: ReactNode;
}) {
  const t = useT();

  const visibleCategories = CATEGORIES.filter(
    (c) => !HIDDEN_CATEGORY_IDS.includes(c.id) && compatibleCount(c) > 0,
  );

  return (
    <div className="flex gap-3">
      {/* Category sidebar */}
      <div className="w-36 flex flex-col gap-2 shrink-0">
        {/* Body type toggle */}
        <div className="flex gap-1 mb-1">
          {BODY_TYPES.map((bt) => (
            <button
              key={bt.id}
              onClick={() => onBodyTypeChange(bt.id)}
              className={`flex-1 px-2 py-1 rounded text-xs ${
                bodyType === bt.id
                  ? "bg-indigo-600 text-white"
                  : "bg-gray-700 text-gray-300 hover:bg-gray-600"
              }`}
            >
              {bt.id === "male" ? t("characters.male") : t("characters.female")}
            </button>
          ))}
        </div>

        {/* Skin color */}
        <div className="flex gap-1 mb-1">
          {SKINS.map((v) => (
            <button
              key={v}
              onClick={() => onSkinChange(v)}
              className={`flex-1 py-2 rounded ${
                layers.body?.variant === v
                  ? "ring-2 ring-indigo-500"
                  : "hover:ring-1 hover:ring-gray-500"
              }`}
              style={{ background: SKIN_COLORS[v] }}
              title={v}
            />
          ))}
        </div>

        {presetsSlot}

        {/* Category tabs */}
        <div className="flex flex-col gap-0.5 max-h-[35vh] overflow-y-auto">
          {visibleCategories.map((cat) => (
            <button
              key={cat.id}
              onClick={() => onSetActiveCategory(cat.id)}
              className={`text-left px-2 py-1.5 rounded text-xs ${
                activeCategory === cat.id
                  ? "bg-indigo-600 text-white"
                  : "bg-gray-700 text-gray-300 hover:bg-gray-600"
              }`}
            >
              {t("characters.cat." + cat.id) || cat.label}
              {layers[cat.id] && <span className="ml-1 text-indigo-300">*</span>}
            </button>
          ))}
        </div>
      </div>

      {/* Inline item list */}
      <div className="flex-1 max-h-[40vh] overflow-y-auto">
        {activeCat && !HIDDEN_CATEGORY_IDS.includes(activeCategory) && (
          <>
            <h4 className="text-xs font-semibold text-gray-400 mb-2">
              {t("characters.cat." + activeCat.id) || activeCat.label}
              <span className="ml-1 text-gray-500">({activeCat.items.length})</span>
            </h4>

            <button
              onClick={() => onClearCategory(activeCategory)}
              className={`w-full text-left px-2 py-1.5 rounded text-xs mb-1 ${
                currentSelection === null || currentSelection === undefined
                  ? "bg-indigo-600 text-white"
                  : "bg-gray-700 text-gray-300 hover:bg-gray-600"
              }`}
            >
              {t("characters.none")}
            </button>

            <div className="flex flex-col gap-0.5">
              {activeCat.items
                .filter((item) => !["body_skeleton", "body_zombie"].includes(item.key))
                .filter((item) => isItemCompatible(item.key))
                .map((item) => {
                  const isSelected = currentSelection?.itemKey === item.key;
                  return (
                    <div key={item.key}>
                      <button
                        onClick={() =>
                          onSelectItem(
                            activeCategory,
                            item.key,
                            currentSelection?.variant &&
                              item.variants.includes(currentSelection.variant)
                              ? currentSelection.variant
                              : item.variants[0],
                          )
                        }
                        className={`w-full text-left px-2 py-1.5 rounded text-xs ${
                          isSelected
                            ? "bg-indigo-600 text-white"
                            : "bg-gray-700 text-gray-300 hover:bg-gray-600"
                        }`}
                      >
                        {t("characters.item." + item.key) || item.name}
                      </button>
                      {isSelected && item.variants.length > 1 && (
                        <div className="flex flex-wrap gap-0.5 mt-0.5 mb-0.5 px-1">
                          {item.variants.map((v) => (
                            <button
                              key={v}
                              title={t("color." + v)}
                              onClick={() => onSetVariant(activeCategory, v)}
                              className={`px-1.5 py-0.5 rounded text-[10px] ${
                                currentSelection?.variant === v
                                  ? "bg-indigo-500 text-white"
                                  : "bg-gray-600 text-gray-300 hover:bg-gray-500"
                              }`}
                            >
                              {t("color." + v)}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Full-mode Item Drawer
// ---------------------------------------------------------------------------

function ItemDrawer({
  activeCat,
  activeCategory,
  currentSelection,
  layers,
  onSelectItem,
  onClearCategory,
  onSetVariant,
  onClose,
  isItemCompatible,
  getItemBodyTypes,
}: {
  activeCat: RegistryCategory;
  activeCategory: string;
  currentSelection: AppearanceSelection | null | undefined;
  layers: Record<string, AppearanceSelection | null>;
  onSelectItem: (catId: string, itemKey: string, variant: string) => void;
  onClearCategory: (catId: string) => void;
  onSetVariant: (catId: string, variant: string) => void;
  onClose: () => void;
  isItemCompatible: (itemKey: string) => boolean;
  getItemBodyTypes: (itemKey: string) => string[];
  variant: "full" | "compact";
}) {
  const t = useT();

  return (
    <div className="w-56 bg-[#1a1f2e] border-l border-gray-700 p-3 sticky top-0 self-start h-screen overflow-y-auto scrollbar-hide">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-300">
          {t("characters.cat." + activeCat.id) || activeCat.label}
        </h3>
        <button onClick={onClose} className="text-gray-500 hover:text-gray-300 px-2">
          <X className="w-4 h-4" />
        </button>
      </div>

      {!["body", "eye_color"].includes(activeCategory) && (
        <button
          onClick={() => onClearCategory(activeCategory)}
          className={`w-full text-left px-3 py-2 rounded text-sm mb-2 ${
            currentSelection === null || currentSelection === undefined
              ? "bg-indigo-600 text-white"
              : "bg-gray-700 text-gray-300 hover:bg-gray-600"
          }`}
        >
          {t("characters.none")}
        </button>
      )}

      <div className="flex flex-col gap-1 max-h-[70vh] overflow-y-auto">
        {[...activeCat.items]
          .filter((item) => !["body_skeleton", "body_zombie"].includes(item.key))
          .sort((a, b) => {
            const aOk = isItemCompatible(a.key) ? 0 : 1;
            const bOk = isItemCompatible(b.key) ? 0 : 1;
            return aOk - bOk;
          })
          .map((item) => {
            const isSelected = currentSelection?.itemKey === item.key;
            const compatible = isItemCompatible(item.key);
            const supportedTypes = !compatible ? getItemBodyTypes(item.key) : [];
            return (
              <div key={item.key}>
                <button
                  onClick={() => {
                    if (!compatible) return;
                    onSelectItem(
                      activeCategory,
                      item.key,
                      currentSelection?.variant && item.variants.includes(currentSelection.variant)
                        ? currentSelection.variant
                        : item.variants[0],
                    );
                  }}
                  className={`w-full text-left px-3 py-2 rounded text-sm flex items-center justify-between ${
                    !compatible
                      ? "bg-gray-800/50 text-gray-600 cursor-not-allowed"
                      : isSelected
                        ? "bg-indigo-600 text-white"
                        : "bg-gray-700/60 text-gray-300 hover:bg-gray-600"
                  }`}
                >
                  <span className="truncate">{t("characters.item." + item.key) || item.name}</span>
                  {!compatible && (
                    <span className="text-[10px] px-1.5 rounded bg-gray-700 text-gray-500 ml-1 shrink-0">
                      {supportedTypes.join(",")}
                    </span>
                  )}
                </button>

                {isSelected && item.variants.length > 1 && (
                  <div className="flex flex-wrap gap-1 mt-1 mb-1.5 px-1">
                    {item.variants.map((v) => (
                      <button
                        key={v}
                        title={t("color." + v)}
                        onClick={() => onSetVariant(activeCategory, v)}
                        className={`px-2 py-1 rounded text-xs ${
                          currentSelection?.variant === v
                            ? "bg-indigo-500 text-white"
                            : "bg-gray-600 text-gray-300 hover:bg-gray-500"
                        }`}
                      >
                        {t("color." + v)}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
      </div>
    </div>
  );
}
