"use client";

import { useT } from "@/lib/i18n";

import GamePageClient from "./GamePageClient";
import { WebglGate } from "./webgl-gate";

/** Wiring for the game page — the channel screen mounts only after passing the gate. */
export default function GameWebglGate() {
  const t = useT();

  return (
    <WebglGate
      renderWorkspace={(onFatal) => <GamePageClient onFatal={onFatal} />}
      renderChecking={() => (
        <div className="min-h-screen flex items-center justify-center bg-bg text-text">
          {t("common.loading")}
        </div>
      )}
    />
  );
}
