/**
 * 로컬 프로필 발견이 **허용되는가**를 판정하는 순수 함수들.
 *
 * 스펙 §4는 "언제 로컬인가"를 2단계로 정의한다.
 *
 *   1단계  URL 호스트가 루프백인가          127.0.0.1 / localhost / ::1 / 0.0.0.0
 *   2단계  프로필 루트가 실제로 존재하는가
 *
 * 최종 리뷰 C1: 구현에 1단계가 없었다. 그 결과 인증된 아무 사용자나
 * `POST /api/gateways` 로 임의 URL의 게이트웨이 레코드를 만들어 자기 것으로
 * 소유하고, 옵인한 뒤, **호스트 머신**의 `~/.hermes 아래 .env` 키를 읽어 그 키를
 * `Authorization: Bearer` 로 자기 URL에 보낼 수 있었다. 1단계는 성능 최적화가
 * 아니라 그 유출 벡터를 끊는 **보안 게이트**다 — 토큰이 실제 로컬 Hermes로만 간다.
 *
 * 여기에 인스턴스 레벨 게이트를 하나 더 얹는다. 게이트웨이 레코드의 `isOwner`는
 * "이 레코드는 내 것"일 뿐 "이 머신은 내 것"이 아니다. DeskRPG는 다중 사용자
 * 가상 오피스이므로, 호스트 파일시스템의 비밀을 읽는 동의는 **운영자**만 줄 수
 * 있어야 한다. 기본값은 꺼짐이며, 꺼져 있으면 기능은 에러가 아니라 **부재**로
 * 보인다(프로필 루트가 없는 컨테이너와 동일한 `available: false`).
 */

/** 운영자가 켜야 하는 인스턴스 레벨 스위치. 기본값 꺼짐. */
export const LOCAL_DISCOVERY_ENV_FLAG = "DESKRPG_LOCAL_DISCOVERY_ENABLED";

const TRUTHY = new Set(["1", "true", "yes", "on"]);

export function isLocalDiscoveryEnabled(env: Record<string, string | undefined>): boolean {
  const raw = (env[LOCAL_DISCOVERY_ENV_FLAG] || "").trim().toLowerCase();
  return TRUTHY.has(raw);
}

/**
 * 호스트 문자열이 루프백인가. URL의 `hostname`을 그대로 받는다 — IPv6는
 * WHATWG URL이 대괄호를 붙여 돌려주므로("[::1]") 여기서 벗긴다.
 */
export function isLoopbackHost(host: string): boolean {
  let h = host.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  // "localhost." 처럼 루트 라벨이 붙은 FQDN 형태도 같은 곳을 가리킨다.
  if (h.endsWith(".")) h = h.slice(0, -1);
  if (!h) return false;
  if (h === "localhost") return true;
  // IPv4 루프백은 127.0.0.0/8 전체다. 0.0.0.0 은 "이 머신의 모든 인터페이스"로
  // 스펙이 명시적으로 로컬로 취급한다.
  if (h === "0.0.0.0") return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(h)) {
    return h.split(".").every((o) => Number(o) <= 255);
  }
  // IPv6: ::1, 그리고 IPv4-mapped 형태(::ffff:127.0.0.1).
  if (h === "::1" || h === "::") return true;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h);
  if (mapped) return isLoopbackHost(mapped[1]);
  return false;
}

/** baseUrl 이 이 머신의 루프백을 가리키는가. 파싱 불가면 로컬이 아니다. */
export function isLoopbackBaseUrl(baseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return isLoopbackHost(url.hostname);
}

/**
 * 파일시스템에 손대기 **전에** 통과해야 하는 두 게이트의 합.
 * 통과하지 못하면 호출자는 프로필 루트를 존재 확인조차 하지 않는다.
 */
export function localDiscoveryAllowed(input: {
  env: Record<string, string | undefined>;
  baseUrl: string;
}): boolean {
  return isLocalDiscoveryEnabled(input.env) && isLoopbackBaseUrl(input.baseUrl);
}
