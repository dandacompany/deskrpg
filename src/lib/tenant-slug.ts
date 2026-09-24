/**
 * A subproject's tenant slug. Since a Hermes card carries this string as-is,
 * **once set, it's never changed** — the display name lives separately in the meta table.
 *
 * It isn't narrowed to ASCII, so a Korean name doesn't become an empty slug. Hermes'
 * `tasks.tenant` is free text and accepts Unicode letters·digits as-is.
 */
export const TENANT_SLUG_MAX = 64;
export const TENANT_SLUG_PATTERN = /^[\p{Ll}\p{Lo}\p{N}][\p{Ll}\p{Lo}\p{N}_-]{0,63}$/u;

/**
 * A name with no letters or digits at all (whitespace only, symbols only) returns an **empty
 * string**. An empty slug is invalid (`isTenantSlug("") === false`) — the caller must not store
 * it and should instead tell the user "a slug can't be made from this name." If an empty value
 * reaches the DB, two differently-named subprojects collide on the unique constraint.
 */
export function tenantSlugFromName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, TENANT_SLUG_MAX)
    .replace(/-+$/g, "");
}

export function isTenantSlug(value: string): boolean {
  return TENANT_SLUG_PATTERN.test(value);
}
