import { normalizeLocale, type ServerLocale } from "./server";

/**
 * LLM instruction templates exist in two variants: the original Korean text (kept byte-for-byte so existing
 * Korean deployments behave exactly as before) and an English one used for every other locale.
 */
export type PromptLocale = "ko" | "en";

export function promptLocale(locale: string | null | undefined): PromptLocale {
  return normalizeLocale(locale) === "ko" ? "ko" : "en";
}

const LANGUAGE_NAMES: Record<ServerLocale, "Korean" | "English" | "Japanese" | "Chinese"> = {
  ko: "Korean",
  en: "English",
  ja: "Japanese",
  zh: "Chinese",
};

/** English name of the language, for directives such as "Write every string value in Japanese." */
export function languageName(locale: string | null | undefined) {
  return LANGUAGE_NAMES[normalizeLocale(locale)];
}
