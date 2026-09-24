"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { accentClasses, type ChatAccent } from "./chat-accent";
import { useT } from "@/lib/i18n";
import MentionEditor, { type MentionEditorHandle } from "./mention-input/MentionEditor";
import type { MentionCandidate } from "./mention-input/mention-model";

interface ChatInputProps {
  onSend: (message: string, files?: File[]) => void;
  value?: string;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  disabledPlaceholder?: string;
  cooldown?: boolean;
  maxLength?: number;
  autoFocus?: boolean;
  showFileUpload?: boolean;
  /** Accent color. Only pre-defined brand-token classes can be chosen — see `chat-accent.ts`. */
  accent?: ChatAccent;
  /**
   * When present, uses the `@` mention editor instead of a textarea. The candidates must match
   * the set the server responds with (channel chat: NPCs on duty; meeting: participating NPCs).
   * The sent value is serialized as `@[name]`.
   */
  mentionCandidates?: MentionCandidate[];
  /** Which conversation this input belongs to. Not shown on screen, only exposed via `data-chat-scope` (picked up by captures/e2e). */
  scope?: "room" | "npc" | "meeting";
}

export default function ChatInput({
  onSend,
  value,
  onValueChange,
  placeholder,
  disabled = false,
  disabledPlaceholder,
  cooldown = false,
  maxLength = 500,
  autoFocus = false,
  showFileUpload = false,
  accent = "npc",
  mentionCandidates,
  scope,
}: ChatInputProps) {
  const t = useT();
  const [input, setInput] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mentionRef = useRef<MentionEditorHandle>(null);
  const useMentions = Array.isArray(mentionCandidates);
  const controlled = value !== undefined;
  const draft = controlled ? value : input;
  const updateDraft = useCallback(
    (next: string) => {
      if (!controlled) setInput(next);
      onValueChange?.(next);
    },
    [controlled, onValueChange],
  );

  // Auto-resize textarea
  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px"; // max ~5 lines
  }, []);

  useEffect(() => {
    adjustHeight();
  }, [draft, adjustHeight]);

  // Auto-focus when enabled
  useEffect(() => {
    if (autoFocus && !disabled && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [autoFocus, disabled]);

  // Re-focus when cooldown/disabled ends
  useEffect(() => {
    if (!disabled && !cooldown && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [disabled, cooldown]);

  const handleSend = useCallback(() => {
    const trimmed = draft.trim();
    if (!trimmed && files.length === 0) return;
    if (cooldown || disabled) return;
    onSend(trimmed, files.length > 0 ? files : undefined);
    updateDraft("");
    setFiles([]);
    mentionRef.current?.clear();
    // Reset height
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [draft, files, cooldown, disabled, onSend, updateDraft]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Prevent the simulation from intercepting keys while this has focus
      e.stopPropagation();

      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files;
    if (!selected) return;
    const newFiles = Array.from(selected).slice(0, 3); // max 3 files
    setFiles((prev) => [...prev, ...newFiles].slice(0, 3));
    e.target.value = ""; // reset for re-select
  }, []);

  const removeFile = useCallback((idx: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const canSend = (draft.trim() || files.length > 0) && !cooldown && !disabled;

  const accentTheme = accentClasses(accent);
  const btnColor = canSend
    ? accentTheme.sendButton
    : "bg-surface-raised text-text-dim cursor-not-allowed";
  const resolvedPlaceholder = placeholder ?? t("chat.placeholder");
  const resolvedDisabledPlaceholder = disabledPlaceholder ?? t("chat.responding");

  return (
    <div className="border-t border-border px-3 py-2" data-chat-scope={scope}>
      {/* File preview */}
      {files.length > 0 && (
        <div className="flex gap-2 mb-2 flex-wrap">
          {files.map((f, i) => (
            <div
              key={i}
              className="flex items-center gap-1 bg-surface rounded px-2 py-1 text-xs text-text-secondary"
            >
              <span className="truncate max-w-[120px]">{f.name}</span>
              <span className="text-text-dim">({(f.size / 1024).toFixed(0)}KB)</span>
              <button
                onClick={() => removeFile(i)}
                className="text-text-dim hover:text-danger ml-1"
                aria-label={t("chat.removeFile")}
                title={t("chat.removeFile")}
              >
                x
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-end gap-2">
        {/* File upload button */}
        {showFileUpload && (
          <>
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled}
              className="p-2 text-text-muted hover:text-text rounded hover:bg-white/10 shrink-0 self-end"
              title={t("chat.attachFile")}
              aria-label={t("chat.attachFile")}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={handleFileSelect}
              accept=".txt,.md,.json,.csv,.pdf,.xlsx,.xls,.docx,.doc,.png,.jpg,.jpeg,.gif,.webp"
            />
          </>
        )}

        {/* Textarea or mention editor */}
        {useMentions ? (
          <MentionEditor
            ref={mentionRef}
            candidates={mentionCandidates ?? []}
            value={draft}
            onChange={(v) => updateDraft(v.slice(0, maxLength))}
            onSubmit={handleSend}
            placeholder={
              cooldown
                ? t("chat.cooldown")
                : disabled
                  ? resolvedDisabledPlaceholder
                  : resolvedPlaceholder
            }
            disabled={disabled}
            autoFocus={autoFocus}
            accent={accent}
          />
        ) : (
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => {
              if (!disabled) updateDraft(e.target.value.slice(0, maxLength));
            }}
            onKeyDown={handleKeyDown}
            placeholder={
              cooldown
                ? t("chat.cooldown")
                : disabled
                  ? resolvedDisabledPlaceholder
                  : resolvedPlaceholder
            }
            rows={1}
            readOnly={disabled}
            className={`flex-1 bg-surface text-text px-3 py-2 rounded-lg border focus:outline-none text-sm min-w-0 resize-none overflow-hidden leading-5 ${
              disabled ? "border-border text-text-dim" : `border-border ${accentTheme.focusBorder}`
            }`}
            style={{ maxHeight: "120px" }}
          />
        )}

        {/* Send button */}
        <button
          onClick={handleSend}
          disabled={!canSend}
          className={`px-3 py-2 rounded-lg font-semibold text-sm shrink-0 self-end transition-colors ${btnColor}`}
        >
          {t("common.send")}
        </button>
      </div>

      {/* Character count */}
      {draft.length > maxLength * 0.8 && (
        <div className="text-right mt-1">
          <span
            className={`text-[10px] ${draft.length >= maxLength ? "text-danger" : "text-text-dim"}`}
          >
            {draft.length}/{maxLength}
          </span>
        </div>
      )}
    </div>
  );
}
