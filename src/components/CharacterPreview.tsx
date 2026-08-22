"use client";

import { useEffect, useRef, useCallback } from "react";
import type { CharacterAppearance } from "@/lib/lpc-registry";
import { FRAME_WIDTH, FRAME_HEIGHT, WALK_COLS, compositeCharacter } from "@/lib/sprite-compositor";

const DIRECTION_MAP: Record<string, number> = { up: 0, left: 1, down: 2, right: 3 };

interface CharacterPreviewProps {
  appearance: CharacterAppearance;
  scale?: number;
  fps?: number;
  direction?: string;
  /** Whether the component is active (for modal usage — pauses animation when false) */
  active?: boolean;
}

export default function CharacterPreview({
  appearance,
  scale = 3,
  fps = 8,
  direction = "down",
  active = true,
}: CharacterPreviewProps) {
  const hiddenCanvasRef = useRef<HTMLCanvasElement>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef(0);

  // Composite sprite when appearance changes
  useEffect(() => {
    const canvas = hiddenCanvasRef.current;
    if (!canvas || !active) return;
    compositeCharacter(canvas, appearance).catch(() => {});
  }, [appearance, active]);

  // Animation loop
  const dirRow = DIRECTION_MAP[direction] ?? 2;
  const animate = useCallback(() => {
    const hidden = hiddenCanvasRef.current;
    const preview = previewCanvasRef.current;
    if (!hidden || !preview) return;

    const ctx = preview.getContext("2d");
    if (!ctx) return;

    preview.width = FRAME_WIDTH * scale;
    preview.height = FRAME_HEIGHT * scale;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, preview.width, preview.height);
    ctx.drawImage(
      hidden,
      frameRef.current * FRAME_WIDTH,
      dirRow * FRAME_HEIGHT,
      FRAME_WIDTH,
      FRAME_HEIGHT,
      0,
      0,
      FRAME_WIDTH * scale,
      FRAME_HEIGHT * scale,
    );
    frameRef.current = (frameRef.current + 1) % WALK_COLS;
  }, [scale, dirRow]);

  useEffect(() => {
    if (!active) return;
    const interval = setInterval(animate, 1000 / fps);
    return () => clearInterval(interval);
  }, [active, animate, fps]);

  return (
    <>
      <canvas ref={hiddenCanvasRef} className="hidden" />
      <canvas
        ref={previewCanvasRef}
        width={FRAME_WIDTH * scale}
        height={FRAME_HEIGHT * scale}
        className="border border-gray-700 rounded bg-gray-950"
      />
    </>
  );
}
