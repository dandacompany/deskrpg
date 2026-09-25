import { ConnectorsApiError } from "./connectors-api";
import { CONNECTOR_ERROR_CODES } from "./connector-types";

type T = (key: string, params?: Record<string, string | number>) => string;

const KNOWN = new Set<string>(CONNECTOR_ERROR_CODES);

/** Turns a failure into on-screen text. Unknown codes collapse to `connectors.error.action` so raw code names never reach the screen. */
export function connectorErrorText(t: T, error: unknown): string {
  if (error instanceof ConnectorsApiError && KNOWN.has(error.code)) {
    const reasons = Array.isArray(error.extra.reasons) ? error.extra.reasons.join("; ") : "";
    return t(`connectors.error.${error.code}`, { detail: reasons || error.message });
  }
  return t("connectors.error.action");
}
