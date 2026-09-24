"use client";

import { useEffect } from "react";

/**
 * As the topmost layer, this modal takes Esc, closes on it, and consumes it via preventDefault.
 * Lower layers (such as a chat window) ignore an Esc whose defaultPrevented is true. An already-consumed Esc is likewise ignored here.
 */
export function useEscapeClose(onEscape: () => void) {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onEscape();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onEscape]);
}
