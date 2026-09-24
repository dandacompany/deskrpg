"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { useT } from "../lib/i18n";

// There's no subscription event for clipboard API availability, and it's unavailable on the server.
const subscribeClipboard = () => () => {};
const clipboardAvailable = () =>
  typeof navigator !== "undefined" && typeof navigator.clipboard?.writeText === "function";
const serverClipboardAvailable = () => false;

/**
 * Shows the command that needs to be pasted and attaches a copy button.
 *
 * In the install instructions, what the user ultimately does boils down to one thing: "paste this
 * line into the terminal." Until now they had to select it by hand, and long lines were easy to
 * grab only partially inside horizontal scroll.
 *
 * The clipboard only opens in a secure context (HTTPS/localhost). On an instance served over plain
 * HTTP, hide the button and just show the command as before — don't leave a button that does
 * nothing when pressed.
 */
export function CopyCommand({ command, className }: { command: string; className?: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const canCopy = useSyncExternalStore(
    subscribeClipboard,
    clipboardAvailable,
    serverClipboardAvailable,
  );
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
    } catch {
      return; // If it's rejected, stay quiet — the command is still shown on screen.
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className={`relative ${className ?? ""}`}>
      <pre className="overflow-x-auto rounded-lg bg-bg px-3 py-2 pr-20 text-xs text-text">
        {command}
      </pre>
      {canCopy && (
        <button
          type="button"
          onClick={() => void copy()}
          className="absolute top-1.5 right-1.5 rounded border border-border bg-surface-raised px-2 py-1 text-[11px] text-text-muted hover:text-text"
        >
          {copied ? t("common.copied") : t("common.copy")}
        </button>
      )}
    </div>
  );
}
