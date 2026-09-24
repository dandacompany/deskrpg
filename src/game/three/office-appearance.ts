import { OFFICE_LOOKS, type OfficeLook } from "./office-looks";

/**
 * The source of truth for the appearance model. Server (API routes, socket handlers) and client both import it, so
 * browser APIs and DB access must not enter this file.
 *
 * The canonical form is only the two keys `{ officeLookId, bodyType }`. `officeLookId` is an ID in `OFFICE_LOOKS`
 * and `bodyType` equals that look's `bodyType`. Extra keys are preserved when saving and passing along.
 */

export type OfficeBodyType = OfficeLook["bodyType"];

export type CharacterAppearance = {
  officeLookId: string;
  bodyType: OfficeBodyType;
} & Record<string, unknown>;

/** An old LPC layer selection (`{ itemKey, variant }`). Used only in DB conversion code. */
export interface AppearanceSelection {
  itemKey: string;
  variant: string;
}

/** An even older layer format (`{ type, variant }`). Used only in DB conversion code. */
export interface AppearanceLayer {
  type: string;
  variant: string;
}

/**
 * The old layered appearance. Used to read values saved back when there was no look ID or only layer keys.
 * New code builds nothing with this type — fold it with `normalizeOfficeAppearance`.
 */
export interface LegacyCharacterAppearance {
  officeLookId?: string;
  bodyType?: string;
  layers?: Record<string, AppearanceSelection | null>;
  body?: AppearanceLayer;
  eyes?: AppearanceLayer;
  nose?: AppearanceLayer | null;
  hair?: AppearanceLayer | null;
  torso?: AppearanceLayer | null;
  legs?: AppearanceLayer | null;
  feet?: AppearanceLayer | null;
}

/** The first male look — the default appearance and the fallback when conversion fails. */
export const DEFAULT_OFFICE_LOOK_ID = "office-jun";
/** The look that an old appearance's `bodyType === "female"` folds into. */
export const DEFAULT_FEMALE_OFFICE_LOOK_ID = "office-nari";

/** If a look the conversion rules point to is not in the real list, the data itself is broken — do not pass over it quietly. */
export function findOfficeLook(id: unknown): OfficeLook | undefined {
  if (typeof id !== "string") return undefined;
  return OFFICE_LOOKS.find((look) => look.id === id);
}

export function isOfficeLookId(id: unknown): id is string {
  return findOfficeLook(id) !== undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * REST validation. Returns an error message, or `null` if valid.
 * Rejects a missing or unknown `officeLookId`. A `bodyType` mismatch is not
 * rejected — `normalizeOfficeAppearance` overwrites it with the look's value before saving.
 */
export function validateOfficeAppearance(value: unknown): string | null {
  if (!isRecord(value)) return "appearance must be an object";
  if (typeof value.officeLookId !== "string" || !value.officeLookId)
    return "appearance.officeLookId is required";
  if (!isOfficeLookId(value.officeLookId))
    return `unknown office look: ${String(value.officeLookId)}`;
  return null;
}

function fallbackLook(bodyType: unknown): OfficeLook {
  const id = bodyType === "female" ? DEFAULT_FEMALE_OFFICE_LOOK_ID : DEFAULT_OFFICE_LOOK_ID;
  const look = findOfficeLook(id);
  if (!look) throw new Error(`Default office look missing from OFFICE_LOOKS: ${id}`);
  return look;
}

/**
 * Fold any value into the canonical form (conversion rule D).
 *
 * - `null`/`undefined` → `null` as is.
 * - JSON strings follow the same rules after parsing, and parse failures give the default look.
 * - For a valid `officeLookId`, extra keys are preserved and only `bodyType` is overwritten with the look's value.
 * - Otherwise the old `bodyType === "female"` → `office-nari`, the rest → `office-jun`.
 *   The result is only the two keys, and old layer keys are dropped.
 */
export function normalizeOfficeAppearance(value: unknown): CharacterAppearance | null {
  if (value === null || value === undefined) return null;
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = undefined;
    }
    // The string "null" is not an absent value but a broken one — fold it into the default look.
  }
  if (!isRecord(parsed)) {
    const look = fallbackLook(undefined);
    return { officeLookId: look.id, bodyType: look.bodyType };
  }
  const look = findOfficeLook(parsed.officeLookId);
  if (look) return { ...parsed, officeLookId: look.id, bodyType: look.bodyType };
  const fallback = fallbackLook(parsed.bodyType);
  return { officeLookId: fallback.id, bodyType: fallback.bodyType };
}

/** The default appearance in canonical form (the first male look). A new object on every call. */
export function defaultOfficeAppearance(): CharacterAppearance {
  const look = fallbackLook(undefined);
  return { officeLookId: look.id, bodyType: look.bodyType };
}
