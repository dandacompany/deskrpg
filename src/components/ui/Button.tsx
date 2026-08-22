"use client";

import { forwardRef } from "react";
import type { ReactNode, ButtonHTMLAttributes } from "react";

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  variant?: "primary" | "secondary" | "danger" | "ghost";
  size?: "sm" | "md" | "lg";
  icon?: ReactNode;
  loading?: boolean;
  children?: ReactNode;
}

const VARIANT_CLASSES: Record<string, string> = {
  primary: "bg-primary text-white hover:bg-primary-hover",
  secondary: "bg-surface-raised text-text-secondary hover:brightness-125",
  danger: "bg-danger-bg text-white hover:brightness-90",
  ghost: "bg-transparent text-text-muted hover:bg-surface",
};

const SIZE_CLASSES: Record<string, string> = {
  sm: "px-2.5 py-1 text-caption rounded-md gap-1",
  md: "px-3.5 py-1.5 text-body rounded-md gap-1.5",
  lg: "px-5 py-2.5 text-title rounded-lg gap-2",
};

const ICON_SIZE: Record<string, string> = {
  sm: "w-3 h-3",
  md: "w-3.5 h-3.5",
  lg: "w-4 h-4",
};

const ICON_ONLY_SIZE: Record<string, string> = {
  sm: "p-1.5 rounded-md",
  md: "p-2 rounded-md",
  lg: "p-2.5 rounded-lg",
};

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = "primary",
      size = "md",
      icon,
      loading,
      disabled,
      children,
      className = "",
      ...rest
    },
    ref,
  ) => {
    const isDisabled = disabled || loading;
    const iconOnly = !children && (icon || loading);

    return (
      <button
        ref={ref}
        disabled={isDisabled}
        className={`
          inline-flex items-center justify-center font-semibold transition-colors
          ${VARIANT_CLASSES[variant]}
          ${iconOnly ? ICON_ONLY_SIZE[size] : SIZE_CLASSES[size]}
          ${isDisabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}
          ${className}
        `
          .trim()
          .replace(/\s+/g, " ")}
        {...rest}
      >
        {loading ? (
          <span
            className={`${ICON_SIZE[size]} animate-spin border-2 border-current border-t-transparent rounded-full`}
          />
        ) : icon ? (
          <span className={ICON_SIZE[size]}>{icon}</span>
        ) : null}
        {children}
      </button>
    );
  },
);
Button.displayName = "Button";
export default Button;
