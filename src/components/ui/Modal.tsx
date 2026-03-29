"use client";

import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";

const SIZE_CLASSES: Record<string, string> = {
  sm: "max-w-md",
  md: "max-w-2xl",
  lg: "max-w-4xl",
  full: "max-w-[90vw]",
};

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  size?: "sm" | "md" | "lg" | "full";
  /** If true, Escape key will NOT close the modal */
  disableEscapeClose?: boolean;
  children: ReactNode;
}

function ModalRoot({ open, onClose, title, size = "md", disableEscapeClose, children }: ModalProps) {
  useEffect(() => {
    if (!open || disableEscapeClose) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose, disableEscapeClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className={`
          ${SIZE_CLASSES[size]} w-full mx-4 max-h-[90vh]
          bg-bg rounded-xl shadow-2xl border border-border
          flex flex-col overflow-hidden
        `.trim().replace(/\s+/g, " ")}
        onClick={(e) => e.stopPropagation()}
      >
        {title && (
          <div className="flex items-center justify-between px-6 py-4 border-b border-border flex-shrink-0">
            <h2 className="text-heading text-text">{title}</h2>
            <button onClick={onClose} className="text-text-muted hover:text-text transition-colors">
              <X className="w-5 h-5" />
            </button>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

function ModalBody({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`flex-1 overflow-y-auto px-6 py-4 ${className}`}>{children}</div>;
}

function ModalFooter({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`px-6 py-4 border-t border-border flex items-center justify-end gap-3 flex-shrink-0 ${className}`}>
      {children}
    </div>
  );
}

const Modal = Object.assign(ModalRoot, {
  Body: ModalBody,
  Footer: ModalFooter,
});

export default Modal;
