"use client";

import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useT } from "@/lib/i18n";
import { getLocalizedErrorMessage } from "@/lib/i18n/error-codes";
import LocaleSwitcher from "@/components/LocaleSwitcher";
import CharacterPreview from "@/components/CharacterPreview";
import AppearanceEditor from "@/components/AppearanceEditor";
import { useCharacterAppearance } from "@/hooks/useCharacterAppearance";
import { OFFICE_PRESETS, type OfficePreset } from "@/lib/office-presets";
import type { CharacterAppearance } from "@/lib/lpc-registry";
import { useEffect } from "react";

export default function CharacterCreatePage() {
  const t = useT();
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center bg-gray-900 text-white">{t("common.loading")}</div>}>
      <CharacterCreatePageInner />
    </Suspense>
  );
}

function CharacterCreatePageInner() {
  const t = useT();
  const router = useRouter();
  const searchParams = useSearchParams();
  const joinChannel = searchParams.get("joinChannel");
  const editId = searchParams.get("editId");
  const isEditMode = !!editId;

  const appearance = useCharacterAppearance();
  const {
    bodyType, setBodyType, layers, setLayers,
    activeCategory, setActiveCategory,
    handleBodyTypeChange, selectItem, clearCategory, setVariant, setSkin,
    isItemCompatible, getItemBodyTypes, compatibleCount,
    randomize, buildAppearance,
  } = appearance;

  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [loadingEdit, setLoadingEdit] = useState(isEditMode);

  // Load existing character data in edit mode
  useEffect(() => {
    if (!editId) return;
    fetch(`/api/characters/${editId}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.character) {
          setName(data.character.name);
          const app = data.character.appearance as CharacterAppearance;
          if (app.bodyType) setBodyType(app.bodyType);
          if (app.layers) setLayers(app.layers);
        }
        setLoadingEdit(false);
      })
      .catch(() => {
        setError(t("errors.failedToLoadCharacter"));
        setLoadingEdit(false);
      });
  }, [editId, setBodyType, setLayers, t]);

  // Apply a preset outfit
  const applyPreset = (preset: OfficePreset) => {
    setBodyType(preset.bodyType);
    setLayers({ ...preset.layers });
  };

  const handleSave = async () => {
    if (!name.trim()) {
      setError(t("errors.characterNameRequired"));
      return;
    }
    setSaving(true);
    setError("");

    try {
      if (isEditMode) {
        const res = await fetch(`/api/characters/${editId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: name.trim(), appearance: buildAppearance() }),
        });
        if (!res.ok) {
          const data = await res.json();
          setError(getLocalizedErrorMessage(t, data, "errors.failedToUpdateCharacter"));
          setSaving(false);
          return;
        }
        router.push(joinChannel ? `/characters?joinChannel=${joinChannel}` : "/characters");
      } else {
        const res = await fetch("/api/characters", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: name.trim(), appearance: buildAppearance() }),
        });
        if (!res.ok) {
          const data = await res.json();
          setError(getLocalizedErrorMessage(t, data, "errors.failedToCreateCharacter"));
          setSaving(false);
          return;
        }
        const data = await res.json();
        if (joinChannel && data.character?.id) {
          router.push(`/game?channelId=${joinChannel}&characterId=${data.character.id}`);
        } else {
          router.push(joinChannel ? `/characters?joinChannel=${joinChannel}` : "/characters");
        }
      }
    } catch {
      setError(t("common.networkError"));
      setSaving(false);
    }
  };

  if (loadingEdit) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-900 text-white">
        {t("common.loading")}
      </div>
    );
  }

  const presetsSlot = (
    <div>
      <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
        {t("characters.presets")}
      </h3>
      <div className="grid grid-cols-2 gap-1.5">
        <button
          onClick={randomize}
          className="col-span-2 px-3 py-2 bg-indigo-900/60 hover:bg-indigo-800 rounded text-sm text-indigo-300 text-center font-semibold mb-0.5"
        >
          {t("characters.random")}
        </button>
        {OFFICE_PRESETS.map((preset) => (
          <button
            key={preset.id}
            onClick={() => applyPreset(preset)}
            className="px-2.5 py-2 bg-gray-700 hover:bg-gray-600 rounded text-xs text-gray-300 text-left whitespace-nowrap"
            title={t(preset.nameKey)}
          >
            {t(preset.nameKey)}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-gray-900 text-white flex">
      <AppearanceEditor
        bodyType={bodyType}
        layers={layers}
        activeCategory={activeCategory}
        onBodyTypeChange={(bt) => handleBodyTypeChange(bt, !isEditMode)}
        onSkinChange={setSkin}
        onSelectItem={selectItem}
        onClearCategory={clearCategory}
        onSetVariant={setVariant}
        onSetActiveCategory={(id) => setActiveCategory(activeCategory === id ? "" : id)}
        isItemCompatible={isItemCompatible}
        getItemBodyTypes={getItemBodyTypes}
        compatibleCount={compatibleCount}
        variant="full"
        presetsSlot={presetsSlot}
      />

      {/* Center — preview */}
      <div className="flex-1 flex flex-col items-center justify-center gap-6 p-8 sticky top-0 self-start h-screen relative">
        <div className="absolute top-4 right-4">
          <LocaleSwitcher />
        </div>
        <CharacterPreview appearance={buildAppearance()} />

        <input
          type="text"
          placeholder={t("characters.namePlaceholderShort")}
          maxLength={50}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-64 px-4 py-2 rounded bg-gray-800 border border-gray-700 text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />

        {error && <p className="text-red-400 text-sm">{error}</p>}

        <div className="flex gap-3">
          <button
            onClick={() => router.back()}
            className="px-6 py-2 bg-gray-700 hover:bg-gray-600 rounded font-semibold"
          >
            {t("common.cancel")}
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-6 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 rounded font-semibold"
          >
            {saving
              ? t("common.loading")
              : isEditMode ? t("common.save") : t("characters.create")}
          </button>
        </div>
      </div>
    </div>
  );
}
