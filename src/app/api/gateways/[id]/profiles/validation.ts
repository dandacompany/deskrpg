import { isValidProfileName } from "@/lib/hermes/profile-name";

/** Hermes rejects profile-scoped keys under 16 chars (hermes_cli.auth.has_usable_secret). */
const MIN_TOKEN_LENGTH = 16;

/** 프로필 이름 문법의 정본은 `src/lib/hermes/profile-name.ts` 하나다 — 파일시스템
 * 경로나 게이트웨이 URL 세그먼트를 프로필 이름으로 만드는 곳(local-discovery
 * 라우트, probe 라우트, readProfileToken)은 전부 그것을 import 한다. 여기서는
 * 기존 호출자를 위해 다시 export 만 한다. 규칙 자체를 여기에 복사하지 말 것. */
export { isValidProfileName };

export type RegistrationValidation =
  | { ok: true; profileName: string; token: string }
  | { ok: false; errorCode: "invalid_profile_name" | "invalid_token" };

export function validateProfileRegistration(input: {
  profileName?: unknown;
  token?: unknown;
}): RegistrationValidation {
  const profileName = typeof input.profileName === "string" ? input.profileName.trim() : "";
  const token = typeof input.token === "string" ? input.token.trim() : "";

  if (!profileName || !isValidProfileName(profileName)) {
    return { ok: false, errorCode: "invalid_profile_name" };
  }
  if (token.length < MIN_TOKEN_LENGTH) {
    return { ok: false, errorCode: "invalid_token" };
  }
  return { ok: true, profileName, token };
}
