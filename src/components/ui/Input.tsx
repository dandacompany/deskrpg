"use client";

import { forwardRef } from "react";
import type { ReactNode, InputHTMLAttributes, TextareaHTMLAttributes } from "react";

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  icon?: ReactNode;
  error?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ icon, error, className = "", ...rest }, ref) => {
    return (
      <div className="w-full">
        <div className="relative">
          {icon && (
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted w-3.5 h-3.5">
              {icon}
            </span>
          )}
          <input
            ref={ref}
            className={`
              w-full px-3 py-2 text-body rounded-md
              bg-surface border border-border text-text placeholder-text-muted
              focus:outline-none focus:ring-2 focus:ring-primary-light focus:border-transparent
              disabled:opacity-50 disabled:cursor-not-allowed
              ${icon ? "pl-9" : ""}
              ${error ? "border-danger" : ""}
              ${className}
            `
              .trim()
              .replace(/\s+/g, " ")}
            {...rest}
          />
        </div>
        {error && <p className="text-danger text-caption mt-1">{error}</p>}
      </div>
    );
  },
);
Input.displayName = "Input";

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  error?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ error, className = "", ...rest }, ref) => {
    return (
      <div className="w-full">
        <textarea
          ref={ref}
          className={`
            w-full px-3 py-2 text-body rounded-md resize-none
            bg-surface border border-border text-text placeholder-text-muted
            focus:outline-none focus:ring-2 focus:ring-primary-light focus:border-transparent
            disabled:opacity-50 disabled:cursor-not-allowed
            ${error ? "border-danger" : ""}
            ${className}
          `
            .trim()
            .replace(/\s+/g, " ")}
          {...rest}
        />
        {error && <p className="text-danger text-caption mt-1">{error}</p>}
      </div>
    );
  },
);
Textarea.displayName = "Textarea";
