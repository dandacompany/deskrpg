"use client";
import DOMPurify from "dompurify";
import { useEffect, useMemo, useState } from "react";

/** Strips scripts/event handlers from the SVG, then renders it as a blob `<img>` (XSS prevention). */
export default function SvgViewer({ text }: { text: string }) {
  const clean = useMemo(
    () => DOMPurify.sanitize(text, { USE_PROFILES: { svg: true, svgFilters: true } }),
    [text],
  );
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    const url = URL.createObjectURL(new Blob([clean], { type: "image/svg+xml" }));
    // A blob URL is external state (the browser's URL registry) that can only be created here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [clean]);
  return src ? <img src={src} alt="" className="max-h-full max-w-full object-contain" /> : null;
}
