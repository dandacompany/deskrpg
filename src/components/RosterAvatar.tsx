"use client";

import { useEffect, useState } from "react";
import { resolveOfficeLook } from "@/game/three/office-looks";

/**
 * A small round avatar used in rosters (players, NPCs). Pulled out of `GamePageClient`
 * so it could be shared with `NpcRoster`.
 *
 * When there's a look, a 3D thumbnail; when the thumbnail isn't ready yet, the first
 * letter of the look name; when there's no appearance, "?".
 * The server normalizes an appearance whose look ID is unknown, so here it just folds
 * down to "?".
 */
export default function RosterAvatar({
  appearance,
  size = 28,
}: {
  appearance: unknown;
  size?: number;
}) {
  const look = resolveOfficeLook(appearance);
  const [portrait, setPortrait] = useState<{ id: string; url: string } | null>(null);
  useEffect(() => {
    if (!look) return;
    let cancelled = false;
    void import("./office-roster-thumbnail")
      .then(({ officeRosterThumbnail }) => officeRosterThumbnail(look))
      .then((url) => {
        if (!cancelled && url) setPortrait({ id: look.id, url });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [look]);

  if (look) {
    return (
      <div
        className="rounded-full bg-surface-raised shrink-0 overflow-hidden flex items-center justify-center text-micro"
        style={{ width: size, height: size }}
      >
        {portrait?.id === look.id ? (
          <img
            src={portrait.url}
            alt=""
            width={size}
            height={size}
            style={{ width: size, height: size, objectFit: "cover" }}
          />
        ) : (
          <span aria-hidden="true">{look.name.slice(0, 1)}</span>
        )}
      </div>
    );
  }

  return (
    <div
      className="rounded-full bg-surface-raised flex items-center justify-center text-text-secondary text-micro font-bold shrink-0"
      style={{ width: size, height: size }}
    >
      ?
    </div>
  );
}
