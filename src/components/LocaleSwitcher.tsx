"use client";
import { useLocale, useT, LOCALES } from "@/lib/i18n";

export default function LocaleSwitcher({ className }: { className?: string }) {
  const { locale, setLocale } = useLocale();
  const t = useT();
  return (
    <select
      value={locale}
      onChange={(e) => setLocale(e.target.value as typeof locale)}
      aria-label={t("common.language")}
      style={{
        background: "var(--color-primary-muted)",
        color: "var(--text)",
        borderColor: "#ccd6c4",
        colorScheme: "light",
      }}
      className={`text-xs border rounded px-1.5 py-0.5 cursor-pointer ${className ?? ""}`}
    >
      {LOCALES.map((l) => (
        <option key={l.code} value={l.code}>
          {l.label}
        </option>
      ))}
    </select>
  );
}
