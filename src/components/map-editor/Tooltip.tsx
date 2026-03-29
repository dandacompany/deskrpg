'use client';

import { useState, useRef, type ReactNode } from 'react';

interface TooltipProps {
  label: string;
  shortcut?: string;
  children: ReactNode;
}

export default function Tooltip({ label, shortcut, children }: TooltipProps) {
  const [show, setShow] = useState(false);
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleEnter = () => {
    timeout.current = setTimeout(() => setShow(true), 400);
  };
  const handleLeave = () => {
    if (timeout.current) clearTimeout(timeout.current);
    timeout.current = null;
    setShow(false);
  };

  return (
    <div className="relative inline-flex" onMouseEnter={handleEnter} onMouseLeave={handleLeave}>
      {children}
      {show && (
        <div className="absolute top-full left-1/2 -translate-x-1/2 mt-1.5 z-[60] pointer-events-none whitespace-nowrap">
          <div className="bg-bg border border-border rounded-md px-2 py-1 shadow-lg flex items-center gap-2">
            <span className="text-micro text-text">{label}</span>
            {shortcut && (
              <span className="text-micro text-text-dim bg-surface-raised px-1 py-0.5 rounded font-mono">
                {shortcut}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
