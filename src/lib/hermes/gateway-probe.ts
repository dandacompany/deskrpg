/**
 * 게이트웨이 레벨 도달성 프로브.
 *
 * Hermes에서 인증이 걸리는 것은 프로필 스코프이므로(named 프로필은 fail-closed로
 * 자기 API_SERVER_KEY를 요구한다), 게이트웨이 레벨에서 확인할 수 있는 것은
 * "이 주소에 Hermes API Server가 떠 있는가"뿐이다. 토큰이 맞는지는 프로필
 * 테스트(validateHermesProfile)가 본다 — 여기서 중복하지 않는다.
 *
 * **`/health` 하나로는 부족하다.** 그 엔드포인트는 무인증이고, Hermes 대시보드도
 * 200을 낸다. 대시보드는 SPA라 catch-all로 아무 경로에나 200 + HTML을 돌려주므로
 * 상태 코드만 보면 진짜 API Server와 구분되지 않는다 — 실측으로 확인했다:
 *
 *     API Server (8643)  /health 200 · /v1/models 401 application/json
 *     대시보드   (9119)  /health 200 · /v1/models 200 text/html
 *
 * 그래서 `/v1/models`를 한 번 더 찌르고 **content-type이 JSON인지**로 가른다.
 * 토큰은 필요 없다 — 진짜 API Server는 무인증 요청을 JSON으로 거절한다.
 */
export type GatewayProbeResult =
  | { kind: "hermes"; status: number }
  /** 응답은 Hermes지만 API Server가 아니다(대시보드 등). 고칠 것은 토큰이 아니라 포트다. */
  | { kind: "dashboard"; status: number }
  | { kind: "not-hermes"; status: number }
  | { kind: "unreachable"; error: string };

// 8초였다가 실측을 보고 25초로 올렸다. `/health` 는 상수를 돌려주는 핸들러라
// (api_server.py:2999-3001) 빠를 것 같지만, 멀티플렉싱하는 게이트웨이는 서빙하는
// 모든 프로필의 플랫폼을 한 프로세스에 이고 있다. 그중 하나가 동기 블로킹으로
// 굳으면(실측: 여러 프로필의 IMAP 어댑터가 30초씩 타임아웃) 이벤트 루프가 멈춰
// 상수 반환조차 늦어진다. 8초는 그때 "게이트웨이가 죽었다"로 오판했다.
// 25초는 정상 게이트웨이에는 영향이 없고(수 ms), 느린 게이트웨이를 죽은 것으로
// 부르지 않을 만큼은 준다.
const DEFAULT_TIMEOUT_MS = 25000;

export async function probeHermesGateway(
  baseUrl: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number; profile?: string } = {},
): Promise<GatewayProbeResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const base = baseUrl.replace(/\/+$/, "");
  // 프로필 스코프는 /p/<name>/ 프리픽스다. 이름은 인코딩한다 — 검증을 통과하지 않은
  // 이름이 그대로 들어오는 경로(원격 검증)가 있다.
  const prefix = opts.profile ? `${base}/p/${encodeURIComponent(opts.profile)}` : base;
  const url = `${prefix}/health`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const health = await fetchImpl(url, { method: "GET", signal: controller.signal });
    if (!health.ok) return { kind: "not-hermes", status: health.status };

    // 여기부터가 대시보드와 API Server 를 가르는 자리다(위 주석 참조).
    const models = await fetchImpl(`${prefix}/v1/models`, {
      method: "GET",
      signal: controller.signal,
    });
    const contentType = models.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("json")) {
      return { kind: "dashboard", status: models.status };
    }
    return { kind: "hermes", status: health.status };
  } catch (err) {
    // AbortError도 여기로 온다 — 호출자 입장에서 "못 닿았다"와 구분할 실익이 없다.
    return { kind: "unreachable", error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}
