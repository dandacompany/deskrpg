"use client";

/**
 * Renders a web artifact in an isolated iframe. Gives only `sandbox="allow-scripts"` — never
 * add `allow-same-origin`, since that would let the artifact's script reach the DeskRPG origin
 * (cookies/API).
 */

/** Wraps a fragment with no `<html`/`<!doctype` in a minimal document (same shape as the desktop `composeArtifactHtml`). */
export function composeHtml(text: string): string {
  if (/<html[\s>]|<!doctype/i.test(text)) return text;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>${text}</body></html>`;
}

export default function HtmlViewer({ text, title }: { text: string; title: string }) {
  return (
    <iframe
      sandbox="allow-scripts"
      srcDoc={composeHtml(text)}
      title={title}
      className="w-full h-full min-h-[60dvh] bg-white rounded-md border border-border"
    />
  );
}
