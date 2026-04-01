"use client";
import { type ReactNode } from "react";
import { I18nProvider, type Locale } from "@/lib/i18n";

export default function Providers({
  children,
  initialLocale,
}: {
  children: ReactNode;
  initialLocale: Locale;
}) {
  return <I18nProvider initialLocale={initialLocale}>{children}</I18nProvider>;
}
