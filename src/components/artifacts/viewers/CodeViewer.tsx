"use client";
import { useEffect, useState } from "react";

/** Bodies longer than this skip highlighting, to avoid holding the main thread too long. */
const HIGHLIGHT_MAX_CHARS = 100_000;

/**
 * Lazy-loads shiki and renders highlighted HTML. An unknown language, `text`, or a very long
 * body stays as plain `<pre>`.
 */
export default function CodeViewer({ text, language }: { text: string; language: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const plain = language === "text" || text.length > HIGHLIGHT_MAX_CHARS;
  useEffect(() => {
    if (plain) return;
    let alive = true;
    void import("shiki")
      .then(({ codeToHtml }) => codeToHtml(text, { lang: language, theme: "github-dark" }))
      .catch(() => null)
      .then((out) => {
        if (alive) setHtml(out);
      });
    return () => {
      alive = false;
    };
  }, [text, language, plain]);
  if (plain || html === null)
    return <pre className="whitespace-pre-wrap font-mono text-xs">{text}</pre>;
  // shiki's output is static HTML with the code string escaped (no scripts).
  return (
    <div
      className="text-xs [&_pre]:p-3 [&_pre]:overflow-auto"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
