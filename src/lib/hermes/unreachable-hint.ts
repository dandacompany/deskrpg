/**
 * 연결 실패의 원인을 좁힌다.
 *
 * "연결하지 못했습니다" 만으로는 사용자가 무엇을 고쳐야 할지 모른다. 실제로 가장 흔한
 * 원인은 주소 자체가 아니라 **어디서 보는 주소인가**다 — DeskRPG 가 컨테이너 안에서
 * 돌면 `127.0.0.1` 은 Hermes 가 아니라 컨테이너 자신을 가리킨다. 브라우저에서는 잘
 * 열리는 주소라 사용자는 주소가 맞다고 확신하고, 그 확신이 진단을 막는다.
 */
export function diagnoseUnreachable(opts: {
  baseUrl: string;
  inContainer: boolean;
}): "gateway_loopback_in_container" | "failed_to_reach_test_endpoint" {
  if (opts.inContainer && isLoopback(opts.baseUrl)) return "gateway_loopback_in_container";
  return "failed_to_reach_test_endpoint";
}

function isLoopback(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  // IPv6 는 URL 파서가 대괄호를 **남긴 채** 준다 — 실측: new URL("http://[::1]:8643").hostname
  // === "[::1]". 벗겨진다고 가정했다가 테스트가 잡았다.
  return host === "localhost" || host === "[::1]" || host === "::1" || host.startsWith("127.");
}
