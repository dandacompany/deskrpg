"use client";
import { useEffect, useRef, useState } from "react";
import { OfficeRenderer } from "@/game/three/office-renderer";
import { tiledSnapshot } from "@/game/three/tiled-preview";
import type { TiledMap } from "@/lib/tiled-map";
import { useT } from "@/lib/i18n";

export default function ThreeMapPreview({ map }: { map: TiledMap }) {
  const host = useRef<HTMLDivElement>(null),
    labels = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const t = useT();
  useEffect(() => {
    if (!host.current || !labels.current) return;
    let view: OfficeRenderer;
    try {
      view = new OfficeRenderer(host.current, labels.current);
    } catch {
      // WebGL capability failure is external state discovered only during allocation.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setFailed(true);
      return;
    }
    const snapshot = tiledSnapshot(map);
    const blocked = new Set(snapshot.blocked);
    view.attach({
      actors: () => [],
      mapKey: () => "editor-preview",
      map: () => snapshot,
      editor: () => ({ placement: false, spawn: false, owner: false, tiled: true, seatLabels: [] }),
      pointer: () => {},
      setPresentation: () => {},
      walkable: (x, y) =>
        x >= 0 && x < map.width && y >= 0 && y < map.height && !blocked.has(`${x},${y}`),
    });
    view.overview(map.width, map.height);
    return () => view.dispose();
  }, [map]);
  return (
    <div className="relative h-full w-full bg-surface-raised">
      <div ref={host} className="absolute inset-0" />
      <div ref={labels} className="absolute inset-0 pointer-events-none" />
      <p className="absolute bottom-4 right-4 rounded-lg bg-surface px-3 py-2 text-caption text-text-muted border border-border">
        {failed ? t("mapPreview.webglUnavailable") : t("mapPreview.controlsHint")}
      </p>
    </div>
  );
}
