"use client";

import { useEffect, useState } from "react";

import { useT, useLocale } from "@/lib/i18n";
import { getLocalizedErrorMessage } from "@/lib/i18n/error-codes";
import CharacterPreview from "@/components/CharacterPreview";
import OfficeLookGallery from "@/components/OfficeLookGallery";
import { officeLookAppearance, resolveOfficeLook } from "@/game/three/office-looks";
import { lookLabel } from "@/game/three/office-look-labels";
import {
  DEFAULT_OFFICE_LOOK_ID,
  normalizeOfficeAppearance,
  type CharacterAppearance,
} from "@/game/three/office-appearance";
import { BIO_MAX_LENGTH } from "@/lib/my-character-limits";
import "@/game/three/lookbook.css";

type MyCharacter = {
  id: string;
  name: string;
  bio: string | null;
  appearance: CharacterAppearance;
};

/**
 * The whole `/characters` screen — "my character" is one per user. When `GET /api/characters/me`
 * gives null it is registration mode, and with a character the same form is shown in edit mode (spec 2026-09-18).
 */
export default function MyCharacterForm({ onSaved }: { onSaved?: () => void } = {}) {
  const t = useT(),
    { locale } = useLocale(),
    ko = locale === "ko";
  const [character, setCharacter] = useState<MyCharacter | null | undefined>(undefined);
  const isEditMode = !!character;

  const [name, setName] = useState(""),
    [bio, setBio] = useState(""),
    [selectedAppearance, setSelectedAppearance] = useState<CharacterAppearance | null>(null);
  const [saving, setSaving] = useState(false),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(false);
  const [direction, setDirection] = useState(0),
    [walking, setWalking] = useState(false);
  const directions = ["down", "left", "up", "right"];
  const selected = resolveOfficeLook(selectedAppearance);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/characters/me", { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error("load");
        const data = await res.json();
        if (controller.signal.aborted) return;
        const mine = data.character as MyCharacter | null;
        setCharacter(mine);
        if (mine) {
          setName(mine.name);
          setBio(mine.bio ?? "");
          setSelectedAppearance(normalizeOfficeAppearance(mine.appearance));
        } else {
          setSelectedAppearance(officeLookAppearance(DEFAULT_OFFICE_LOOK_ID));
        }
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setError(t("errors.failedToLoadCharacter"));
        setCharacter(null);
        setSelectedAppearance(officeLookAppearance(DEFAULT_OFFICE_LOOK_ID));
      });
    return () => controller.abort();
  }, [t]);

  const handleSave = async () => {
    if (!selectedAppearance || saving) return;
    if (!name.trim()) {
      setError(t("errors.characterNameRequired"));
      return;
    }
    setSaving(true);
    setError("");
    setSaved(false);

    try {
      const payload = { name: name.trim(), appearance: selectedAppearance, bio };
      const res = isEditMode
        ? await fetch(`/api/characters/${character!.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await fetch("/api/characters", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
      if (!res.ok) {
        const data = await res.json();
        setError(
          getLocalizedErrorMessage(
            t,
            data,
            isEditMode ? "errors.failedToUpdateCharacter" : "errors.failedToCreateCharacter",
          ),
        );
        setSaving(false);
        return;
      }
      const data = await res.json();
      setCharacter(data.character);
      setSaving(false);
      setSaved(true);
      onSaved?.();
    } catch {
      setError(t("common.networkError"));
      setSaving(false);
    }
  };

  if (character === undefined) {
    return (
      <div className="min-h-screen flex items-center justify-center">{t("common.loading")}</div>
    );
  }

  return (
    <div className="lookbook-page">
      <OfficeLookGallery
        selectedId={selected?.id}
        onSelect={(look) => {
          setSelectedAppearance(officeLookAppearance(look.id));
          setError("");
        }}
      />
      <aside className="lookbook-preview" aria-label={t("character.preview.label")}>
        <div className="lookbook-eyebrow">
          {isEditMode ? t("characters.my.editTitle") : t("characters.my.createTitle")}
        </div>
        {selectedAppearance && (
          <CharacterPreview
            appearance={selectedAppearance}
            scale={4.5}
            direction={directions[direction]}
            walking={walking}
          />
        )}
        <div className="lookbook-preview-controls">
          <button
            type="button"
            aria-label={t("character.preview.rotateLeft")}
            onClick={() => setDirection((direction + 1) % 4)}
          >
            ↶
          </button>
          <button type="button" aria-pressed={walking} onClick={() => setWalking(!walking)}>
            {t(walking ? "character.preview.walking" : "character.preview.standing")}
          </button>
          <button
            type="button"
            aria-label={t("character.preview.rotateRight")}
            onClick={() => setDirection((direction + 3) % 4)}
          >
            ↷
          </button>
        </div>
        {selected && (
          <>
            <h2>{lookLabel(selected, locale).name}</h2>
            <p className="lookbook-preview-description">{lookLabel(selected, locale).subtitle}</p>
          </>
        )}
        <div className="lookbook-name">
          <label htmlFor="character-name">{t("character.form.officeName")}</label>
          <input
            id="character-name"
            type="text"
            maxLength={50}
            placeholder={t("characters.namePlaceholderShort")}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="lookbook-name">
          <label htmlFor="character-bio">{t("characters.my.bio")}</label>
          <textarea
            id="character-bio"
            maxLength={BIO_MAX_LENGTH}
            placeholder={t("characters.my.bioPlaceholder")}
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            rows={4}
          />
          <p className="lookbook-field-meta">
            <span>{t("characters.my.bioHint")}</span>
            <span aria-label={t("character.form.charCount")}>
              {bio.length} / {BIO_MAX_LENGTH}
            </span>
          </p>
        </div>
        {error && (
          <p className="lookbook-error" role="alert">
            {error}
          </p>
        )}
        {saved && !error && (
          <p className="lookbook-preview-description">{t("characters.my.saved")}</p>
        )}
        <div className="lookbook-save">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !selectedAppearance || !name.trim()}
          >
            {saving
              ? t("common.loading")
              : isEditMode
                ? t("characters.my.save")
                : t("characters.my.create")}
          </button>
        </div>
      </aside>
    </div>
  );
}
