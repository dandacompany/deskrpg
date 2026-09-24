"use client";

import { useState } from "react";
import type { CharacterAppearance } from "@/game/three/office-appearance";
import { useLocale } from "@/lib/i18n";
import { resolveOfficeLook } from "@/game/three/office-looks";
import CharacterModelView from "./CharacterModelView";

/** The look thumbnail's base size — multiplied by `scale` to get one preview side. */
const PREVIEW_UNIT = 64;

interface CharacterPreviewProps {
  appearance: CharacterAppearance;
  scale?: number;
  direction?: string;
  active?: boolean;
  walking?: boolean;
}

/** 3D preview of the selected look. An appearance with no look collapses to "?" (the server normalizes it on save). */
export default function CharacterPreview({
  appearance,
  scale = 3,
  direction = "down",
  active = true,
  walking = true,
}: CharacterPreviewProps) {
  const look = resolveOfficeLook(appearance);
  const [unavailable, setUnavailable] = useState(false);
  const { locale } = useLocale();
  const size = PREVIEW_UNIT * scale;
  return (
    <div className="flex flex-col items-center gap-2">
      <div className="rounded-2xl border border-border bg-surface-raised overflow-hidden">
        {!look ? (
          <div
            className="flex items-center justify-center text-text-secondary text-2xl font-bold"
            style={{ width: size, height: size }}
            aria-hidden="true"
          >
            ?
          </div>
        ) : unavailable ? (
          <p className="p-5 text-sm text-text-muted" role="status">
            {locale === "ko"
              ? "3D 미리보기를 사용할 수 없습니다. 캐릭터 선택과 저장은 가능합니다."
              : "3D preview unavailable. You can still select and save a character."}
          </p>
        ) : (
          <CharacterModelView
            look={look}
            walking={walking}
            size={size}
            direction={direction}
            active={active}
            onUnavailable={() => setUnavailable(true)}
          />
        )}
      </div>
    </div>
  );
}
