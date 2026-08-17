/**
 * 게이트웨이 레벨 도달성 프로브.
 *
 * Hermes에서 인증이 걸리는 것은 프로필 스코프이므로(named 프로필은 fail-closed로
 * 자기 API_SERVER_KEY를 요구한다), 게이트웨이 레벨에서 확인할 수 있는 것은
 * "이 주소에 Hermes API Server가 떠 있는가"뿐이다. `/health`는 인증이 없다.
 * 토큰이 맞는지는 프로필 테스트(validateHermesProfile)가 본다.
 */
export type GatewayProbeResult =
  | { kind: "hermes"; status: number }
  | { kind: "not-hermes"; status: number }
  | { kind: "unreachable"; error: string };

const DEFAULT_TIMEOUT_MS = 8000;

export async function probeHermesGateway(
  baseUrl: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<GatewayProbeResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `${baseUrl.replace(/\/+$/, "")}/health`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { method: "GET", signal: controller.signal });
    return res.ok
      ? { kind: "hermes", status: res.status }
      : { kind: "not-hermes", status: res.status };
  } catch (err) {
    // AbortError도 여기로 온다 — 호출자 입장에서 "못 닿았다"와 구분할 실익이 없다.
    return { kind: "unreachable", error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}
