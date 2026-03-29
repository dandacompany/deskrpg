'use client';

import { useState, useRef, useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface TooltipProps {
  label: string;
  shortcut?: string;
  children: ReactNode;
}

export default function Tooltip({ label, shortcut, children }: TooltipProps) {
  const [show, setShow] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triggerRef = useRef<HTMLDivElement>(null);

  const handleEnter = () => {
    timeout.current = setTimeout(() => {
      if (triggerRef.current) {
        const rect = triggerRef.current.getBoundingClientRect();
        // Show above the trigger element
        setPos({ x: rect.left + rect.width / 2, y: rect.top - 6 });
      }
      setShow(true);
    }, 400);
  };

  const handleLeave = () => {
    if (timeout.current) clearTimeout(timeout.current);
    timeout.current = null;
    setShow(false);
  };

  useEffect(() => {
    return () => { if (timeout.current) clearTimeout(timeout.current); };
  }, []);

  return (
    <div ref={triggerRef} className="inline-flex" onMouseEnter={handleEnter} onMouseLeave={handleLeave}>
      {children}
      {show && createPortal(
        <div
          className="fixed z-[9999] pointer-events-none whitespace-nowrap"
          style={{ left: pos.x, top: pos.y, transform: 'translate(-50%, -100%)' }}
        >
          <div className="bg-bg border border-border rounded-md px-2 py-1 shadow-lg flex items-center gap-2">
            <span className="text-micro text-text">{label}</span>
            {shortcut && (
              <span className="text-micro text-text-dim bg-surface-raised px-1 py-0.5 rounded font-mono">
                {shortcut}
              </span>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
