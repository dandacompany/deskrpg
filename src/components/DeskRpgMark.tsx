import Image from "next/image";

/**
 * Brand mark — a 3D miniature baked from the same three.js model as HQ, used below the sidebar.
 * The image is re-baked by `npx tsx scripts/brand-mark/render.ts` (model: game/three/office-building.ts).
 * Kept as a PNG so we don't fire up WebGL again on screen — even the 16px favicon comes from the same image.
 */
export default function DeskRpgMark({ size = 25 }: { size?: number }) {
  return (
    <Image
      src="/assets/brand/deskrpg-mark-3d-512.png"
      alt=""
      width={size}
      height={size}
      priority
      aria-hidden="true"
    />
  );
}
