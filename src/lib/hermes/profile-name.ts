/**
 * 프로필 이름 문법의 **정본**. 프로필 이름으로 파일시스템 경로나 게이트웨이 URL
 * 세그먼트를 만드는 곳은 전부 여기를 import 한다 — API 라우트 계층
 * (`app/api/gateways/[id]/profiles/validation.ts`가 재export)과 라이브러리 계층
 * (`local-profiles.ts`) 양쪽이 의존할 수 있도록 `src/lib/` 에 둔다.
 *
 * 최소 하나의 영숫자를 요구하므로 점/대시/언더스코어만으로 된 이름(예: "..")이
 * 통과하지 못한다. `HermesClient.url()`이 이름을 `/p/<name>/` 경로 세그먼트에
 * 그대로 끼워 넣는데 `encodeURIComponent`는 "."을 이스케이프하지 않고, URL
 * 정규화가 ".."을 순회 세그먼트로 접어버린다 — 그러면 프로필 스코프가 조용히
 * 사라지고 요청이 게이트웨이의 기본 프로필 라우트로 간다.
 *
 * 최종 리뷰 I2: 이 정규식이 세 파일에 복사돼 있었다. 규칙을 완화하는 사람이 한
 * 사본만 고치면 등록은 통과하는데 발견·탐침이 거부하는 비대칭이 조용히 생긴다.
 */
export const PROFILE_NAME_RE = /^[A-Za-z0-9._-]*[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isValidProfileName(name: string): boolean {
  return PROFILE_NAME_RE.test(name);
}
