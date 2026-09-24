"use client";

import { useEffect } from "react";

import { REPO_URL } from "@/lib/app-meta";
import { useT } from "@/lib/i18n";

import { useEscapeClose } from "./use-escape-close";
const UPDATE_COMMANDS: { key: string; command: string }[] = [
  { key: "growth.updateNpm", command: "npx deskrpg@latest start" },
  { key: "growth.updateDocker", command: "docker compose pull && docker compose up -d" },
];

/** New version notice. The moment it opens, records that version as seen and turns off the red dot. */
export function UpdateNoticeModal({
  version,
  latestVersion,
  onSeen,
  onClose,
}: {
  version: string;
  latestVersion: string;
  onSeen: () => void;
  onClose: () => void;
}) {
  const t = useT();
  useEscapeClose(onClose);
  useEffect(() => {
    onSeen();
  }, [onSeen]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-w-lg rounded-xl border border-border bg-surface shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-lg font-semibold text-text">{t("growth.updateTitle")}</h2>
          <button
            onClick={onClose}
            className="text-text-dim hover:text-text"
            aria-label={t("common.close")}
          >
            &times;
          </button>
        </div>
        <div className="px-6 py-5 space-y-4 text-sm">
          <p className="text-text">
            {t("growth.updateSummary", { current: version, latest: latestVersion })}
          </p>
          <a
            href={`${REPO_URL}/releases/tag/${latestVersion}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary-light hover:text-primary underline underline-offset-2"
          >
            {t("growth.releaseNotes")}
          </a>
          <ul className="space-y-2">
            {UPDATE_COMMANDS.map(({ key, command }) => (
              <li key={key}>
                <div className="text-text-secondary">{t(key)}</div>
                <code className="block rounded bg-surface-raised px-2 py-1 text-text break-all">
                  {command}
                </code>
              </li>
            ))}
            <li className="text-text-secondary">{t("growth.updateHostinger")}</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
