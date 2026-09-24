"use client";

import Link from "next/link";
import { MonitorX } from "lucide-react";

import { useT } from "@/lib/i18n";

type WebglUnavailableProps = {
  /** "Retry" — re-checks and re-mounts the whole page. */
  onRetry: () => void;
};

/**
 * Full-screen notice shown instead of the channel screen when the 3D office can't start.
 * There's no 2D fallback, so this doesn't offer any way further in — only fix it or go back.
 */
export default function WebglUnavailable({ onRetry }: WebglUnavailableProps) {
  const t = useT();

  return (
    <div
      role="alert"
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg text-text px-6"
    >
      <div className="max-w-md w-full rounded-lg border border-border bg-surface p-6 text-center">
        <MonitorX className="w-10 h-10 mx-auto mb-4 text-danger" aria-hidden />
        <h1 className="text-xl font-semibold mb-3">{t("webgl.unavailableTitle")}</h1>
        <p className="text-sm text-text-muted mb-6 leading-relaxed">
          {t("webgl.unavailableDescription")}
        </p>
        <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
          <button
            type="button"
            onClick={onRetry}
            className="w-full sm:w-auto px-4 py-2 bg-indigo-600 hover:bg-indigo-700 rounded font-semibold"
          >
            {t("webgl.retry")}
          </button>
          <Link
            href="/channels"
            className="w-full sm:w-auto px-4 py-2 rounded border border-border text-text-muted hover:text-text"
          >
            {t("webgl.backToChannels")}
          </Link>
        </div>
      </div>
    </div>
  );
}
