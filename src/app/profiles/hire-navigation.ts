/**
 * Address computation for the hiring (wizard) screen — **the wizard is handled entirely by the one `/profiles/new` page.**
 *
 * The 4-step wizard used to unfold inside the employee list, so one screen held the list, creation, persona editing and model settings
 * at once (a violation of `docs/standards.md`'s "one feature, one page"). The list has only links.
 */
export function hirePageHref(
  gatewayId: string,
  options: { returnTo?: string | null; profile?: string | null } = {},
): string {
  const params = new URLSearchParams({ gateway: gatewayId });
  // The path for continuing to edit an existing employee's persona. Moves there once an employee detail page exists.
  if (options.profile) params.set("profile", options.profile);
  if (options.returnTo) params.set("returnTo", options.returnTo);
  return `/profiles/new?${params.toString()}`;
}

/**
 * Where to go back when the wizard is closed.
 *
 * The server decides the seat — we only go back to the game. If entered via the game screen's "새 직원",
 * send them back there. Otherwise go back to the employee list — where the just-created employee is visible.
 */
export function hireDoneHref(gatewayId: string, returnTo?: string | null): string {
  if (returnTo) return returnTo;
  return `/profiles?gateway=${encodeURIComponent(gatewayId)}`;
}

/**
 * Where to go when the wizard finishes.
 *
 * If it ends with ③'s "완료" (there is an employee name), go to that just-created employee's detail — the place to
 * review appearance, persona and model in one place. If entered from the game screen or ended by closing, go back as before.
 */
export function hireFinishedHref(
  gatewayId: string,
  returnTo: string | null | undefined,
  profileName: string | null,
): string {
  if (profileName && !returnTo) return employeeDetailHref(gatewayId, profileName);
  return hireDoneHref(gatewayId, returnTo);
}

/**
 * The employee detail screen — the place to edit that one employee (persona, appearance, model, account, delete).
 *
 * Profile names are unique within a gateway, so the name goes in the path and the gateway in the query.
 */
export function employeeDetailHref(gatewayId: string, profileName: string): string {
  return `/profiles/${encodeURIComponent(profileName)}?gateway=${encodeURIComponent(gatewayId)}`;
}
