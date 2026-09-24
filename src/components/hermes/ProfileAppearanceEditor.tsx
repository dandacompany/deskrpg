"use client";

import { useState } from "react";
import OfficeLookGallery from "@/components/OfficeLookGallery";
import CharacterPreview from "@/components/CharacterPreview";
import { OFFICE_LOOKS, officeLookAppearance, resolveOfficeLook } from "@/game/three/office-looks";
import { DEFAULT_OFFICE_LOOK_ID } from "@/game/three/office-appearance";
import { getLocalizedErrorMessage } from "@/lib/i18n/error-codes";
import { useT, useLocale } from "@/lib/i18n";
import { lookLabel, lookOutfit } from "@/game/three/office-look-labels";
import type { CharacterAppearance } from "@/game/three/office-appearance";

interface ProfileAppearanceEditorProps {
  gatewayId: string;
  profileId: string;
  initialAppearance: CharacterAppearance | null;
  onSaved: () => void;
}

/** Keep the loaded appearance (including unknown IDs) until a replacement is chosen. */
export default function ProfileAppearanceEditor({
  gatewayId,
  profileId,
  initialAppearance,
  onSaved,
}: ProfileAppearanceEditorProps) {
  const t = useT(),
    { locale } = useLocale();
  const [appearance, setAppearance] = useState(
    () => initialAppearance ?? officeLookAppearance(DEFAULT_OFFICE_LOOK_ID),
  );
  const selected = resolveOfficeLook(appearance);
  const [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  const save = async () => {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const res = await fetch(`/api/gateways/${gatewayId}/profiles/${profileId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appearance }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw data;
      onSaved();
    } catch (err) {
      setError(getLocalizedErrorMessage(t, err, "common.error"));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="mt-3 space-y-3 border-t border-border pt-3">
      <CharacterPreview appearance={appearance} scale={2.5} walking={false} />
      <OfficeLookGallery
        selectedId={selected?.id}
        onSelect={(look) => setAppearance(officeLookAppearance(look.id))}
      />
      <label className="block text-xs text-text-secondary">
        {t("appearanceEditor.officeCharacter")}
        <select
          className="mt-2 w-full rounded border border-border bg-surface p-2 text-text"
          value={selected?.id ?? ""}
          onChange={(e) => {
            if (e.target.value) setAppearance(officeLookAppearance(e.target.value));
          }}
        >
          {!selected && <option value="">{t("appearanceEditor.keepCurrent")}</option>}
          {OFFICE_LOOKS.map((look) => (
            <option key={look.id} value={look.id}>
              {`${lookLabel(look, locale).name} · ${lookOutfit(look, locale)}`}
            </option>
          ))}
        </select>
      </label>
      {error && (
        <p className="text-xs text-danger" role="alert">
          {error}
        </p>
      )}
      <button
        type="button"
        onClick={() => void save()}
        disabled={saving}
        className="rounded bg-primary px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60"
      >
        {saving ? t("common.loading") : t("gateway.profile.appearanceSave")}
      </button>
    </div>
  );
}
