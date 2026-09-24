import { isAccountPasswordValid } from "@/lib/security-policy";

export type PasswordChangePlan =
  | { ok: true; body: { currentPassword: string; newPassword: string } }
  | { ok: false; errorCode: string };

/**
 * What the screen filters before sending to the server. The server checks the same rules again —
 * this is to save a round trip, not a security boundary.
 * Only `password_mismatch` is screen-only (the confirmation field never goes to the server).
 */
export function planPasswordChange(input: {
  current: string;
  next: string;
  confirm: string;
}): PasswordChangePlan {
  if (!input.current || !input.next) {
    return { ok: false, errorCode: "current_new_password_required" };
  }
  if (input.next !== input.confirm) {
    return { ok: false, errorCode: "password_mismatch" };
  }
  if (!isAccountPasswordValid(input.next)) {
    return { ok: false, errorCode: "password_length_invalid" };
  }
  if (input.current === input.next) {
    return { ok: false, errorCode: "password_unchanged" };
  }
  return { ok: true, body: { currentPassword: input.current, newPassword: input.next } };
}
