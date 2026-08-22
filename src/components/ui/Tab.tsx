"use client";

import type { ReactNode } from "react";

export interface TabItem {
  key: string;
  label: string;
  icon?: ReactNode;
  badge?: number;
}

export interface TabProps {
  tabs: TabItem[];
  activeKey: string;
  onChange: (key: string) => void;
  className?: string;
}

export default function Tab({ tabs, activeKey, onChange, className = "" }: TabProps) {
  return (
    <div className={`flex border-b border-border ${className}`}>
      {tabs.map((tab) => {
        const isActive = tab.key === activeKey;
        return (
          <button
            key={tab.key}
            onClick={() => onChange(tab.key)}
            className={`
              flex-1 py-1.5 text-caption text-center flex items-center justify-center gap-1
              ${
                isActive
                  ? "text-primary-light border-b-2 border-primary-light font-bold"
                  : "text-text-muted"
              }
            `
              .trim()
              .replace(/\s+/g, " ")}
          >
            {tab.icon && <span className="w-3.5 h-3.5">{tab.icon}</span>}
            {tab.label}
            {tab.badge != null && tab.badge > 0 && (
              <span className="bg-primary/20 text-primary-light text-micro px-1.5 rounded-full ml-1">
                {tab.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
