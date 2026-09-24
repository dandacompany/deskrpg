import { version } from "../../package.json";

/** The single place for the app version and repo URL. Read by both the browser and the server. */
export const APP_VERSION: string = version;
export const REPO_URL = "https://github.com/dandacompany/deskrpg";
export const BUG_REPORT_BASE_URL = `${REPO_URL}/issues/new`;
export const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE.md`;

function parseCalVer(value: string): number[] | null {
  const parts = value.trim().replace(/^v/, "").split(".");
  if (parts.length === 0 || parts.some((p) => !/^\d+$/.test(p))) return null;
  return parts.map(Number);
}

/** Compares a calendar-style version (2026.921.3) numerically, segment by segment. Returns 0 if either value can't be read. */
export function compareCalVer(a: string, b: string): -1 | 0 | 1 {
  const pa = parseCalVer(a);
  const pb = parseCalVer(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

export function isNewer(latest: string | null | undefined, current: string): boolean {
  return typeof latest === "string" && compareCalVer(latest, current) === 1;
}

export function formatStars(count: number): string {
  if (count < 1000) return String(count);
  const k = count / 1000;
  return `${k >= 10 ? Math.round(k) : Math.round(k * 10) / 10}k`;
}
