"use client";
import { ExternalLink } from "lucide-react";

import { useT } from "@/lib/i18n";

import { safeHttpUrl } from "../artifact-view-model";
import { LinkIcon } from "./link-icon";

/**
 * A link artifact. Re-validates the first line as http(s) — if the stored value is something
 * like `javascript:`, no open link is created. The page title is not fetched (SSRF).
 */
export default function LinkViewer({
  text,
  onCopy,
  copied,
}: {
  text: string;
  onCopy: (value: string) => void;
  copied: boolean;
}) {
  const t = useT();
  const url = safeHttpUrl(text);
  if (!url) {
    return <p className="text-xs text-text-secondary">{t("artifacts.link.invalid")}</p>;
  }
  const host = new URL(url).hostname;
  return (
    <div className="flex flex-col gap-2 text-xs">
      <div className="flex items-center gap-1.5 text-sm font-semibold text-text">
        <LinkIcon url={url} className="w-4 h-4" />
        <span>{host}</span>
      </div>
      <p className="break-all text-text-secondary">{url}</p>
      <div className="flex items-center gap-2">
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-primary hover:bg-primary-hover text-white font-semibold"
        >
          <ExternalLink className="w-3.5 h-3.5" />
          <span>{t("artifacts.link.open")}</span>
        </a>
        <button
          type="button"
          onClick={() => onCopy(url)}
          className="px-2.5 py-1 rounded-md bg-surface-raised text-text-secondary hover:brightness-125"
        >
          {copied ? t("artifacts.copied") : t("artifacts.copy")}
        </button>
      </div>
    </div>
  );
}
