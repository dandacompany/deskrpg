"use client";

import { useState, useRef, useEffect, type ReactNode } from "react";

export interface DropdownItem {
  key: string;
  label: string;
  icon?: ReactNode;
  onClick: () => void;
  className?: string;
}

export interface DropdownProps {
  trigger: ReactNode;
  items: DropdownItem[];
  align?: "left" | "right";
}

export default function Dropdown({ trigger, items, align = "right" }: DropdownProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <div onClick={() => setOpen(!open)}>{trigger}</div>
      {open && (
        <div
          className={`
            absolute top-full mt-1 z-50 min-w-[140px]
            bg-surface border border-border rounded-lg shadow-xl py-1
            ${align === "right" ? "right-0" : "left-0"}
          `
            .trim()
            .replace(/\s+/g, " ")}
        >
          {items.map((item) => (
            <button
              key={item.key}
              onClick={() => {
                item.onClick();
                setOpen(false);
              }}
              className={`
                w-full text-left px-3 py-2 text-body text-text hover:bg-surface-raised
                flex items-center gap-2 transition-colors
                ${item.className || ""}
              `
                .trim()
                .replace(/\s+/g, " ")}
            >
              {item.icon && <span className="w-3.5 h-3.5 shrink-0">{item.icon}</span>}
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
