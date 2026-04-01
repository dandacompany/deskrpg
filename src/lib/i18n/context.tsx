"use client";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import en from "./locales/en";
import ko from "./locales/ko";
import zh from "./locales/zh";
import ja from "./locales/ja";
import { LOCALE_COOKIE_MAX_AGE, LOCALE_COOKIE_NAME, LOCALE_STORAGE_KEY } from "./constants";

export type Locale = "en" | "ko" | "zh" | "ja";
export const LOCALES: { code: Locale; label: string }[] = [
  { code: "en", label: "English" },
  { code: "ko", label: "한국어" },
  { code: "zh", label: "中文" },
  { code: "ja", label: "日本語" },
];

type TranslationMap = Record<string, string>;
const translations: Record<Locale, TranslationMap> = { en, ko, zh, ja };

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function readCookieLocale(): Locale | null {
  if (typeof document === "undefined") return null;
  const cookieValue = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${LOCALE_COOKIE_NAME}=`))
    ?.slice(`${LOCALE_COOKIE_NAME}=`.length);

  return cookieValue && translations[cookieValue as Locale] ? (cookieValue as Locale) : null;
}

function persistLocale(locale: Locale) {
  localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  document.cookie = `${LOCALE_COOKIE_NAME}=${locale}; path=/; max-age=${LOCALE_COOKIE_MAX_AGE}; samesite=lax`;
}

function detectLocale(initialLocale: Locale): Locale {
  if (typeof window === "undefined") return initialLocale;
  const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
  if (stored && translations[stored as Locale]) return stored as Locale;
  const cookieLocale = readCookieLocale();
  if (cookieLocale) return cookieLocale;
  const lang = navigator.language.slice(0, 2);
  if (lang === "ko") return "ko";
  if (lang === "zh") return "zh";
  if (lang === "ja") return "ja";
  return initialLocale;
}

export function I18nProvider({
  children,
  initialLocale = "en",
}: {
  children: ReactNode;
  initialLocale?: Locale;
}) {
  const [locale, setLocaleState] = useState<Locale>(() => detectLocale(initialLocale));

  useEffect(() => {
    persistLocale(locale);
  }, [locale]);

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
  }, []);

  const t = useCallback(
    (key: string, params?: Record<string, string | number>): string => {
      let text = translations[locale][key] ?? translations.en[key] ?? key;
      if (params) {
        for (const [k, v] of Object.entries(params)) {
          text = text.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
        }
      }
      return text;
    },
    [locale],
  );

  return (
    <I18nContext.Provider value={{ locale, setLocale, t }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useT() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useT must be used within I18nProvider");
  return ctx.t;
}

export function useLocale() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useLocale must be used within I18nProvider");
  return { locale: ctx.locale, setLocale: ctx.setLocale };
}
