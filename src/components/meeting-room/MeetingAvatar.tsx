"use client";

import { useEffect, useRef } from "react";

import type {
  CharacterAppearance,
  LegacyCharacterAppearance,
} from "@/lib/lpc-registry";
import { compositeCharacter } from "@/lib/sprite-compositor";

import type { AvatarFacing } from "./avatar-frame";
import { getAvatarFrameRect } from "./avatar-frame";

interface MeetingAvatarProps {
  appearance: CharacterAppearance | LegacyCharacterAppearance | null;
  facing: AvatarFacing;
  size?: number;
  className?: string;
}

export default function MeetingAvatar({
  appearance,
  facing,
  size = 80,
  className = "",
}: MeetingAvatarProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!canvasRef.current || !appearance) return;

    const canvas = canvasRef.current;
    const offscreen = document.createElement("canvas");
    const { sx, sy, sw, sh } = getAvatarFrameRect(facing);

    compositeCharacter(offscreen, appearance)
      .then(() => {
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        canvas.width = size;
        canvas.height = size;
        ctx.clearRect(0, 0, size, size);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(offscreen, sx, sy, sw, sh, 0, 0, size, size);
      })
      .catch(() => {});
  }, [appearance, facing, size]);

  if (!appearance) {
    return (
      <div
        className={`rounded-full bg-surface-raised flex items-center justify-center text-text-secondary text-caption font-bold ${className}`}
        style={{ width: size, height: size }}
      >
        ?
      </div>
    );
  }

  return (
    <canvas
      ref={canvasRef}
      width={size}
      height={size}
      className={`rounded-full bg-surface-raised ${className}`}
      style={{ width: size, height: size, imageRendering: "pixelated" }}
    />
  );
}
