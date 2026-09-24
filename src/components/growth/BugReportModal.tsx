"use client";

import { useMemo, useState } from "react";

import { APP_VERSION } from "@/lib/app-meta";
import { useT } from "@/lib/i18n";

import {
  buildGithubIssueUrl,
  getInstallId,
  collectAttachments,
  postFeedback,
  recentErrorDigest,
  type AttachmentKey,
} from "./feedback-client";
import { useEscapeClose } from "./use-escape-close";
import { browserStorage } from "./growth-storage";

export function BugReportModal({
  feedbackUrl,
  onClose,
}: {
  feedbackUrl: string | null;
  onClose: () => void;
}) {
  const t = useT();
  useEscapeClose(onClose);
  // The modal only renders after the user opens it, so creating the install ID here does not conflict with server rendering.
  const [installId] = useState(() => getInstallId(browserStorage()));
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [repro, setRepro] = useState("");
  const [contact, setContact] = useState("");
  const [excluded, setExcluded] = useState<Set<AttachmentKey>>(new Set());
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "failed">("idle");

  const attachments = useMemo(
    () =>
      collectAttachments({
        version: APP_VERSION,
        userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent,
        viewport: typeof window === "undefined" ? "" : `${window.innerWidth}x${window.innerHeight}`,
        errorDigest: recentErrorDigest(),
      }),
    [],
  );
  const kept = attachments.filter((a) => !excluded.has(a.key));
  const ready = title.trim() !== "" && body.trim() !== "";
  const canSendPrivately =
    ready && feedbackUrl !== null && installId !== null && status !== "sending";

  const toggle = (key: AttachmentKey) =>
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const sendPrivately = async () => {
    if (!feedbackUrl || !installId) return;
    setStatus("sending");
    const value = (key: AttachmentKey) => kept.find((a) => a.key === key)?.value;
    const ok = await postFeedback(feedbackUrl, "/v1/bug-reports", {
      installId,
      title: title.trim(),
      body: body.trim(),
      repro: repro.trim() || undefined,
      contact: contact.trim() || undefined,
      appVersion: value("version") ?? "unknown",
      userAgent: value("userAgent"),
      viewport: value("viewport"),
      errorDigest: value("errorDigest"),
    });
    setStatus(ok ? "sent" : "failed");
  };

  const openGithub = () => {
    window.open(
      buildGithubIssueUrl({
        title: title.trim(),
        body: body.trim(),
        repro: repro.trim(),
        attachments: kept,
      }),
      "_blank",
      "noopener,noreferrer",
    );
    onClose();
  };

  const field = "w-full rounded-md border border-border bg-surface-raised px-2 py-1 text-text";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-xl border border-border bg-surface shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-lg font-semibold text-text">{t("game.reportBug")}</h2>
          <button
            onClick={onClose}
            className="text-text-dim hover:text-text"
            aria-label={t("common.close")}
          >
            &times;
          </button>
        </div>
        {status === "sent" ? (
          <div className="px-6 py-8 text-sm text-text" role="status">
            {t("growth.bugSent")}
          </div>
        ) : (
          <div className="px-6 py-5 space-y-3 text-sm">
            <label className="block space-y-1">
              <span className="text-text-secondary">{t("growth.bugTitle")}</span>
              <input
                value={title}
                maxLength={200}
                onChange={(e) => setTitle(e.target.value)}
                className={field}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-text-secondary">{t("growth.bugBody")}</span>
              <textarea
                rows={3}
                maxLength={8000}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                className={field}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-text-secondary">{t("growth.bugRepro")}</span>
              <textarea
                rows={3}
                maxLength={4000}
                value={repro}
                onChange={(e) => setRepro(e.target.value)}
                className={field}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-text-secondary">{t("growth.bugContact")}</span>
              <input
                value={contact}
                maxLength={200}
                onChange={(e) => setContact(e.target.value)}
                className={field}
              />
            </label>
            <div className="space-y-1">
              <div className="text-text-secondary">{t("growth.bugAttachments")}</div>
              {attachments.map((a) => (
                <label
                  key={a.key}
                  className="flex items-start gap-2 text-caption text-text-secondary"
                >
                  <input
                    type="checkbox"
                    checked={!excluded.has(a.key)}
                    onChange={() => toggle(a.key)}
                    aria-label={t(`growth.attach.${a.key}`)}
                  />
                  <span className="break-all">
                    <span className="text-text-secondary">{t(`growth.attach.${a.key}`)}</span>:{" "}
                    {a.value}
                  </span>
                </label>
              ))}
            </div>
            {status === "failed" && (
              <p className="text-caption text-danger" role="alert">
                {t("growth.sendFailed")}
              </p>
            )}
            <div className="flex flex-wrap justify-end gap-2 pt-2">
              <button
                onClick={openGithub}
                disabled={!ready}
                className="px-3 py-1.5 rounded-md border border-border text-caption text-text-secondary hover:text-text disabled:opacity-60"
              >
                {t("growth.bugGithub")}
              </button>
              {feedbackUrl && (
                <button
                  onClick={sendPrivately}
                  disabled={!canSendPrivately}
                  className="px-3 py-1.5 rounded-md bg-primary hover:bg-primary-light text-white text-caption font-semibold disabled:opacity-60"
                >
                  {t("growth.bugPrivate")}
                </button>
              )}
            </div>
            {feedbackUrl && (
              <p className="text-caption text-text-secondary">{t("growth.bugPrivateNote")}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
