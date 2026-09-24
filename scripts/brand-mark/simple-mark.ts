/**
 * A mark for small sizes only — reduces the headquarters silhouette to three shapes (tower, low wing, roof band).
 *
 * The 3D render smears at 16px. The tab icon uses this simple form; larger spots use the 3D miniature.
 * So the shapes do not diverge, the proportions come from the tower/wing ratio of the real model (office-building.ts).
 */
export type SimpleMarkColors = { background: string; tower: string; wing: string; roof: string };

export const MARK_COLORS: SimpleMarkColors = {
  background: "#365e4b", // Product green — small icons need dark fills for the shape to survive
  tower: "#f3eee2", // cream
  wing: "#c7d0bc",
  roof: "#243f33",
};

/** A square SVG. `size` is the pixel size; the shape proportions stay the same. */
export function simpleMarkSvg(size: number, colors: SimpleMarkColors = MARK_COLORS): string {
  const c = colors;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">`,
    `<rect width="64" height="64" rx="14" fill="${c.background}"/>`,
    // Tower: tall on the left. Keep only two rows of windows — any more turns into a gray blob at 16px.
    `<rect x="13" y="16" width="21" height="34" rx="2" fill="${c.tower}"/>`,
    `<rect x="11" y="13" width="25" height="5" rx="2" fill="${c.roof}"/>`,
    // Low wing: on the right.
    `<rect x="36" y="28" width="16" height="22" rx="2" fill="${c.wing}"/>`,
    `<rect x="34" y="25" width="20" height="4.5" rx="2" fill="${c.roof}"/>`,
    // Entrance and windows — only the large areas.
    `<rect x="20" y="41" width="7" height="9" rx="1.5" fill="${c.roof}"/>`,
    `<rect x="17" y="23" width="6" height="6" rx="1" fill="${c.wing}"/>`,
    `<rect x="26" y="23" width="6" height="6" rx="1" fill="${c.wing}"/>`,
    `<rect x="40" y="34" width="8" height="6" rx="1" fill="${c.tower}"/>`,
    `</svg>`,
  ].join("");
}
