import { LOCALE_COOKIE_NAME } from "./constants";
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

/**
 * Extracts the user's chosen display language from the socket handshake's Cookie header.
 * The browser automatically attaches the `LOCALE_COOKIE_NAME` cookie to a same-origin
 * socket connection — so the server knows "the language of whoever made this request"
 * without a new event field. null if absent (never guessed).
 */
export function readLocaleCookie(cookieHeader: string | null | undefined): ServerLocale | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0 || part.slice(0, eq).trim() !== LOCALE_COOKIE_NAME) continue;
    try {
      const raw = decodeURIComponent(part.slice(eq + 1).trim());
      return raw ? normalizeLocale(raw) : null;
    } catch {
      // A broken percent-encoding (`%E0%A4%A`) throws URIError — don't let one bad cookie crash the socket handler.
      return null;
    }
  }
  return null;
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
