/**
 * Sidebar menu — kept **in onboarding order**: my character → connection → employees → office.
 *
 * This order is exactly the path a new user walks. **"Me" is made first** (without a character,
 * the office screen redirects to the character screen — the redirect in
 * `src/app/channels/page.tsx`). Then the Hermes gateway is connected, an employee is created and
 * the model is logged in as that employee, and finally an office is created and occupied. The
 * old menu had its order scattered and had no `my character` at all.
 *
 * `AI provider` (`/providers`) was dropped because it's a pre-Hermes screen — Hermes manages
 * provider auth on its own, per profile. Clicking it doesn't connect to this product's flow and
 * misleads the user.
 */
export type WorkspaceNavKey = "gateways" | "profiles" | "characters" | "channels";

export const WORKSPACE_NAV: ReadonlyArray<{ key: WorkspaceNavKey; href: string }> = [
  { key: "characters", href: "/characters" },
  { key: "gateways", href: "/gateways" },
  { key: "profiles", href: "/profiles" },
  { key: "channels", href: "/channels" },
];

/** The employees (Hermes profile) screen URL. Employee management happens only at `/profiles`. */
export function employeesHref(
  gatewayId: string,
  options: { create?: boolean; returnTo?: string } = {},
): string {
  const params = new URLSearchParams({ gateway: gatewayId });
  if (options.returnTo) params.set("returnTo", options.returnTo);
  // Hiring is handled by a dedicated page (docs/standards.md "one feature, one page").
  return `/profiles${options.create ? "/new" : ""}?${params.toString()}`;
}
