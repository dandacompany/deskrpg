"use client";

import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";

import type { LinkPreview } from "@/lib/link-preview/parse";

/**
 * Promotes a paragraph containing only a link into a title/description/thumbnail card. If the
 * fetch fails or there is no preview (204), **it changes nothing** — the original underlined link
 * stays as-is.
 *
 * This just re-renders what the server already fetched. The browser never hits the other site
 * directly (`/api/link-preview`; og:image also goes through the `/api/link-preview/image` proxy).
 */
export default function LinkPreviewCard({
  url,
  fallback,
}: {
  url: string;
  fallback: React.ReactNode;
}) {
  const [preview, setPreview] = useState<LinkPreview | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/link-preview?url=${encodeURIComponent(url)}`);
        if (!alive || res.status !== 200) return;
        const data = (await res.json()) as LinkPreview;
        if (alive) setPreview(data);
      } catch {
        // Silently stays as an underlined link.
      }
    })();
    return () => {
      alive = false;
    };
  }, [url]);

  if (!preview) return <>{fallback}</>;

  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    host = preview.siteName ?? "";
  }

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      data-link-preview={host}
      className="my-1.5 flex gap-2 overflow-hidden rounded-md border border-border bg-surface no-underline hover:brightness-110"
    >
      {preview.image && (
        // A third-party image — the URL goes through our proxy, and on failure just leaves the slot empty.
        <img src={preview.image} alt="" className="h-20 w-28 shrink-0 object-cover" />
      )}
      <span className="flex min-w-0 flex-col gap-0.5 px-2 py-1.5">
        <span className="flex items-center gap-1 text-[10px] text-text-dim">
          <ExternalLink className="h-3 w-3 shrink-0" />
          <span className="truncate">{preview.siteName || host}</span>
        </span>
        {preview.title && (
          <span className="line-clamp-2 text-xs font-semibold text-text">{preview.title}</span>
        )}
        {preview.description && (
          <span className="line-clamp-2 text-[11px] text-text-secondary">
            {preview.description}
          </span>
        )}
      </span>
    </a>
  );
}
