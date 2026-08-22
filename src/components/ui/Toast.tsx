"use client";

export interface ToastProps {
  message: string;
  visible: boolean;
}

export default function Toast({ message, visible }: ToastProps) {
  return (
    <div
      className={`
        fixed bottom-8 left-1/2 -translate-x-1/2 z-50
        bg-surface border border-border rounded-lg shadow-xl
        px-4 py-2.5 text-body text-text
        transition-all duration-300
        ${visible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4 pointer-events-none"}
      `
        .trim()
        .replace(/\s+/g, " ")}
    >
      {message}
    </div>
  );
}
