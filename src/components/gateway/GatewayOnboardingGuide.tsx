"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { useT } from "@/lib/i18n";
import { HERMES_AGENT_REPO_URL, PLUGIN_INSTALL_COMMAND } from "@/lib/hermes/plugin-install-command";
import Toast from "@/components/ui/Toast";
import { quickStartGamePath } from "@/lib/quick-start";
import { CopyCommand } from "../CopyCommand";

/**
 * The onboarding guide shown to a user with **zero** gateways.
 *
 * Someone who lands on `/gateways` right after signing up hasn't installed Hermes or
 * logged into a model provider yet. Giving that person just an empty registration form
 * is a dead end — they need to be told first that DeskRPG doesn't bundle an agent runtime.
 */
const TOAST_MS = 3000;

export default function GatewayOnboardingGuide() {
  const t = useT();
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => clearTimeout(toastTimer.current ?? undefined), []);

  const fail = useCallback((message: string) => {
    clearTimeout(toastTimer.current ?? undefined);
    setToast(message);
    toastTimer.current = setTimeout(() => setToast(null), TOAST_MS);
  }, []);

  /**
   * The office can be created even without a gateway — the server creates default
   * character/channel (or reuses them if they already exist) and returns just the two ids.
   */
  const quickStart = useCallback(async () => {
    if (running) return;
    setRunning(true);
    try {
      const response = await fetch("/api/quick-start", { method: "POST" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || typeof payload?.channelId !== "string") {
        fail(t("quickStart.failed"));
        return;
      }
      router.push(quickStartGamePath({ channelId: payload.channelId }));
    } catch {
      fail(t("quickStart.failed"));
    } finally {
      setRunning(false);
    }
  }, [fail, router, running, t]);

  return (
    <section className="mb-6 rounded-xl border border-primary/30 bg-surface p-5">
      <h2 className="text-lg font-semibold">{t("gateways.onboarding.title")}</h2>
      <p className="mt-2 text-sm text-text-muted">{t("gateways.onboarding.intro")}</p>
      <a
        href={HERMES_AGENT_REPO_URL}
        target="_blank"
        rel="noreferrer noopener"
        className="mt-1 inline-block break-all text-sm font-semibold text-primary"
      >
        {HERMES_AGENT_REPO_URL}
      </a>

      <div className="mt-4">
        <p className="text-sm font-semibold">{t("gateways.onboarding.step4Title")}</p>
        <p className="mt-1 text-sm text-text-muted">{t("gateways.onboarding.step4Body")}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={quickStart}
            disabled={running}
            className="rounded-lg bg-primary px-3 py-1.5 text-sm font-semibold text-white hover:bg-primary/90 disabled:opacity-60"
          >
            {t("gateways.onboarding.quickStart")}
          </button>
          <Link
            href="/characters"
            className="rounded-lg bg-surface-raised px-3 py-1.5 text-sm font-medium hover:bg-surface-raised/80"
          >
            {t("gateways.onboarding.step4CharacterLink")}
          </Link>
          <Link
            href="/channels"
            className="rounded-lg bg-surface-raised px-3 py-1.5 text-sm font-medium hover:bg-surface-raised/80"
          >
            {t("gateways.onboarding.step4ChannelLink")}
          </Link>
        </div>
        <p className="mt-1 text-sm text-text-muted">{t("gateways.onboarding.quickStartHint")}</p>
      </div>

      <details className="mt-4">
        <summary className="cursor-pointer text-sm font-semibold">
          {t("gateways.onboarding.manualSetup")}
        </summary>
        <ol className="mt-3 space-y-4">
          <li>
            <p className="text-sm font-semibold">{t("gateways.onboarding.step1Title")}</p>
            <p className="mt-1 text-sm text-text-muted">{t("gateways.onboarding.step1Body")}</p>
            {/* Don't stop at just a repo link — the wizard can install it if it's the same host. */}
            <p className="mt-1 text-sm text-text-muted">
              {t("gateways.onboarding.step1WizardHint")}
            </p>
          </li>

          <li>
            <p className="text-sm font-semibold">{t("gateways.onboarding.step3Title")}</p>
            <p className="mt-1 text-sm text-text-muted">{t("gateways.onboarding.step3Body")}</p>
            <CopyCommand command={PLUGIN_INSTALL_COMMAND} className="mt-2" />
          </li>
        </ol>
      </details>
      <Toast message={toast ?? ""} visible={toast !== null} />
    </section>
  );
}
