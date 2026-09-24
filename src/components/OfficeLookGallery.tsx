"use client";
import { useEffect, useState } from "react";
import * as T from "three";
import { OFFICE_LOOKS, LOOK_CATEGORIES, type OfficeLook } from "@/game/three/office-looks";
import { captureThumbnail } from "@/game/three/office-look-thumbnail";
import { useLocale, useT } from "@/lib/i18n";
import {
  lookCategoryLabel,
  lookLabel,
  lookOutfit,
  lookSearchText,
} from "@/game/three/office-look-labels";

const cachedThumbnails: Record<string, string> = {};

/** One context per mounted generation; each frame captures at most one missing look. */
function generateThumbnails(publish: (images: Record<string, string>) => void) {
  let renderer: T.WebGLRenderer | undefined;
  const controller = new AbortController();
  const { signal } = controller;
  let index = 0;
  let frame = 0;
  const release = () => {
    const current = renderer;
    renderer = undefined;
    if (!current) return;
    try {
      current.dispose();
    } finally {
      current.forceContextLoss();
    }
  };
  const captureNext = async () => {
    if (signal.aborted) return;
    try {
      // Always publish completed images, including an entirely cached remount.
      publish({ ...cachedThumbnails });
      while (index < OFFICE_LOOKS.length && cachedThumbnails[OFFICE_LOOKS[index].id]) index++;
      if (index === OFFICE_LOOKS.length) {
        release();
        return;
      }
      if (!renderer) {
        renderer = new T.WebGLRenderer({
          antialias: true,
          alpha: true,
          preserveDrawingBuffer: true,
        });
        renderer.setSize(240, 280);
        renderer.setPixelRatio(1);
        renderer.outputColorSpace = T.SRGBColorSpace;
      }
      const look = OFFICE_LOOKS[index];
      const image = await captureThumbnail(renderer, look, index++, signal);
      if (signal.aborted) return;
      if (image) cachedThumbnails[look.id] = image;
      publish({ ...cachedThumbnails });
      if (index < OFFICE_LOOKS.length) frame = requestAnimationFrame(captureNext);
      else release();
    } catch {
      // Retain completed images; all text cards remain selectable without WebGL.
      release();
    }
  };
  frame = requestAnimationFrame(captureNext);
  return () => {
    controller.abort();
    cancelAnimationFrame(frame);
    release();
  };
}

export default function OfficeLookGallery({
  selectedId,
  onSelect,
}: {
  selectedId?: string;
  onSelect: (look: OfficeLook) => void;
}) {
  const { locale } = useLocale();
  const t = useT();
  const [images, setImages] = useState<Record<string, string>>({});
  const [category, setCategory] = useState("all"),
    [query, setQuery] = useState("");
  useEffect(() => generateThumbnails(setImages), []);
  const filtered = OFFICE_LOOKS.filter(
    (l) =>
      (category === "all" || l.category === category) &&
      lookSearchText(l).includes(query.toLowerCase().trim()),
  );
  return (
    <section className="lookbook-catalog" aria-label={t("lookbook.collectionLabel")}>
      <div className="lookbook-eyebrow">THE OFFICE COLLECTION · {OFFICE_LOOKS.length} LOOKS</div>
      <h1>{t("lookbook.title")}</h1>
      <p className="lookbook-intro">{t("lookbook.intro")}</p>
      <div className="lookbook-toolbar">
        <input
          type="search"
          aria-label={t("lookbook.searchLabel")}
          placeholder={t("lookbook.searchPlaceholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <span>
          {filtered.length} / {OFFICE_LOOKS.length}
        </span>
      </div>
      <div className="lookbook-filters" aria-label={t("lookbook.filters")}>
        {LOOK_CATEGORIES.map((c) => (
          <button
            key={c.id}
            type="button"
            aria-pressed={category === c.id}
            onClick={() => setCategory(c.id)}
          >
            {lookCategoryLabel(c.id, locale)}
          </button>
        ))}
      </div>
      <div className="lookbook-grid">
        {filtered.map((l) => (
          <button
            type="button"
            className="lookbook-card"
            key={l.id}
            aria-pressed={selectedId === l.id}
            onClick={() => onSelect(l)}
          >
            <div className="lookbook-card-image" style={{ backgroundColor: `${l.coat}10` }}>
              {images[l.id] ? (
                <img src={images[l.id]} alt="" width={240} height={280} />
              ) : (
                <span className="lookbook-placeholder">{lookLabel(l, locale).name}</span>
              )}
              <span className="lookbook-number">
                {String(OFFICE_LOOKS.indexOf(l) + 1).padStart(2, "0")}
              </span>
              {selectedId === l.id && (
                <span className="lookbook-selected">{t("lookbook.selected")}</span>
              )}
            </div>
            <div className="lookbook-card-caption">
              <strong>{lookLabel(l, locale).name}</strong>
              <span>{lookOutfit(l, locale)}</span>
            </div>
          </button>
        ))}
      </div>
      {!filtered.length && <p className="lookbook-empty">{t("lookbook.empty")}</p>}
    </section>
  );
}
