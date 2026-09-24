"use client";
/**
 * Small pieces shared by the three cron screens (list/edit/gallery) — the timezone label
 * (R18/E9) and error notice (R31/R32).
 */
import { useT } from "@/lib/i18n";
import { getWizardErrorMessage, isWizardErrorCode } from "@/components/hermes/wizard-error-codes";

import type { CronErrorNotice as CronErrorNoticeValue } from "./cron-api";

/** "Asia/Seoul (as of...)" — or "gateway timezone unknown" when there is none. */
export function TimezoneLabel({ timezone }: { timezone: string | null | undefined }) {
  const t = useT();
  return (
    <span data-testid="cron-tz" className="text-[11px] text-text-dim">
      {timezone ? t("cron.tzLabel", { tz: timezone }) : t("cron.tzUnknown")}
    </span>
  );
}

export function CronErrorNotice({ notice }: { notice: CronErrorNoticeValue }) {
  const t = useT();
  if (notice.kind === "upgrade") {
    return (
      <div
        role="alert"
        data-testid="cron-error-upgrade"
        className="p-3 rounded border border-amber-600/60 bg-amber-900/20 text-xs text-text space-y-1.5"
      >
        <p className="font-semibold">
          {t("cron.error.upgradeRequired", { minVersion: notice.minVersion })}
        </p>
        <p className="text-text-muted">{t("cron.error.upgradeHint")}</p>
        <code className="block px-2 py-1.5 bg-bg border border-border rounded font-mono text-[11px] break-all select-all">
          {notice.command}
        </code>
      </div>
    );
  }
  if (notice.kind === "gateway") {
    return (
      <div
        role="alert"
        data-testid="cron-error-gateway"
        className="p-3 rounded border border-border bg-surface text-xs text-text"
      >
        {t("cron.error.gatewayNotBound")}
      </div>
    );
  }
  return (
    <div
      role="alert"
      data-testid="cron-error-other"
      className="p-3 rounded border border-red-700/60 bg-red-900/20 text-xs text-text space-y-1"
    >
      {isWizardErrorCode(notice.code) && <p>{getWizardErrorMessage(t, notice.code)}</p>}
      <p className="font-mono text-[11px] text-text-muted break-all">
        {notice.code}: {notice.message}
      </p>
    </div>
  );
}
