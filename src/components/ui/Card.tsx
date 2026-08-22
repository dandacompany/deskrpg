"use client";

import type { ReactNode } from "react";

export interface CardProps {
  selectable?: boolean;
  selected?: boolean;
  onClick?: () => void;
  children: ReactNode;
  className?: string;
}

export default function Card({
  selectable,
  selected,
  onClick,
  children,
  className = "",
}: CardProps) {
  return (
    <div
      onClick={selectable || onClick ? onClick : undefined}
      className={`
        bg-surface border rounded-lg transition-all
        ${selected ? "border-primary-light ring-2 ring-primary bg-primary-muted" : "border-border"}
        ${selectable && !selected ? "hover:ring-2 hover:ring-primary cursor-pointer" : ""}
        ${onClick && !selectable ? "cursor-pointer hover:border-primary-light" : ""}
        ${className}
      `
        .trim()
        .replace(/\s+/g, " ")}
    >
      {children}
    </div>
  );
}
