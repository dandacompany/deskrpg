"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { useT } from "@/lib/i18n";

interface ChatInputProps {
  onSend: (message: string, files?: File[]) => void;
  placeholder?: string;
  disabled?: boolean;
  disabledPlaceholder?: string;
  cooldown?: boolean;
  maxLength?: number;
  autoFocus?: boolean;
  showFileUpload?: boolean;
  accentColor?: string; // tailwind color class for button, e.g. "amber" or "indigo"
}

export default function ChatInput({
  onSend,
  placeholder,
  disabled = false,
  disabledPlaceholder,
  cooldown = false,
  maxLength = 500,
  autoFocus = false,
  showFileUpload = false,
  accentColor = "amber",
}: ChatInputProps) {
  const t = useT();
  const [input, setInput] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Auto-resize textarea
  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px"; // max ~5 lines
  }, []);

  useEffect(() => { adjustHeight(); }, [input, adjustHeight]);

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
    const trimmed = input.trim();
    if (!trimmed && files.length === 0) return;
    if (cooldown || disabled) return;
    onSend(trimmed, files.length > 0 ? files : undefined);
    setInput("");
    setFiles([]);
    // Reset height
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [input, files, cooldown, disabled, onSend]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Prevent Phaser from capturing keys while focused
    e.stopPropagation();

    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

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

  const canSend = (input.trim() || files.length > 0) && !cooldown && !disabled;

  const btnColor = canSend
    ? `bg-${accentColor}-500 hover:bg-${accentColor}-600 text-black`
    : "bg-gray-700 text-gray-500 cursor-not-allowed";
  const resolvedPlaceholder = placeholder ?? t("chat.placeholder");
  const resolvedDisabledPlaceholder = disabledPlaceholder ?? t("chat.responding");

  return (
    <div className="border-t border-gray-700 px-3 py-2">
      {/* File preview */}
      {files.length > 0 && (
        <div className="flex gap-2 mb-2 flex-wrap">
          {files.map((f, i) => (
            <div key={i} className="flex items-center gap-1 bg-gray-800 rounded px-2 py-1 text-xs text-gray-300">
              <span className="truncate max-w-[120px]">{f.name}</span>
              <span className="text-gray-500">({(f.size / 1024).toFixed(0)}KB)</span>
              <button
                onClick={() => removeFile(i)}
                className="text-gray-500 hover:text-red-400 ml-1"
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
              className="p-2 text-gray-400 hover:text-white rounded hover:bg-white/10 shrink-0 self-end"
              title={t("chat.attachFile")}
              aria-label={t("chat.attachFile")}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={handleFileSelect}
              accept=".txt,.md,.json,.csv,.pdf,.png,.jpg,.jpeg,.gif,.webp"
            />
          </>
        )}

        {/* Textarea */}
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => { if (!disabled) setInput(e.target.value.slice(0, maxLength)); }}
          onKeyDown={handleKeyDown}
          placeholder={cooldown ? t("chat.cooldown") : (disabled ? resolvedDisabledPlaceholder : resolvedPlaceholder)}
          rows={1}
          readOnly={disabled}
          className={`flex-1 bg-gray-800 text-white px-3 py-2 rounded-lg border focus:outline-none text-sm min-w-0 resize-none overflow-hidden leading-5 ${
            disabled ? "border-gray-700 text-gray-500" : `border-gray-600 focus:border-${accentColor}-500`
          }`}
          style={{ maxHeight: "120px" }}
        />

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
      {input.length > maxLength * 0.8 && (
        <div className="text-right mt-1">
          <span className={`text-[10px] ${input.length >= maxLength ? "text-red-400" : "text-gray-500"}`}>
            {input.length}/{maxLength}
          </span>
        </div>
      )}
    </div>
  );
}
