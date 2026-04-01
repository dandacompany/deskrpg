import en from "./locales/en";
import ja from "./locales/ja";
import ko from "./locales/ko";
import zh from "./locales/zh";

export type ServerLocale = "en" | "ko" | "ja" | "zh";

const translations: Record<ServerLocale, Record<string, string>> = {
  en,
  ko,
  ja,
  zh,
};

export function normalizeLocale(locale: string | null | undefined): ServerLocale {
  const base = locale?.toLowerCase().slice(0, 2);
  if (base === "ko" || base === "ja" || base === "zh") return base;
  return "en";
}

export function translateServer(
  locale: ServerLocale | string | null | undefined,
  key: string,
  params?: Record<string, string | number>,
): string {
  const normalized = typeof locale === "string" ? normalizeLocale(locale) : "en";
  let text = translations[normalized][key] ?? translations.en[key] ?? key;

  if (params) {
    for (const [paramKey, value] of Object.entries(params)) {
      text = text.replace(new RegExp(`\\{${paramKey}\\}`, "g"), String(value));
    }
  }

  return text;
}
