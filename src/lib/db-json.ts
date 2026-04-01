export function parseDbJson<T = unknown>(value: unknown): T | null {
  if (value == null) return null;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }
  return value as T;
}

export function parseDbObject(value: unknown): Record<string, unknown> | null {
  const parsed = parseDbJson<unknown>(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

export function parseDbArray<T = unknown>(value: unknown): T[] {
  const parsed = parseDbJson<unknown>(value);
  return Array.isArray(parsed) ? (parsed as T[]) : [];
}
