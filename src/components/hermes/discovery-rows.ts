import type { DiscoveryCandidate } from "@/lib/hermes/local-discovery";

export type DiscoveryRow = DiscoveryCandidate & {
  selectable: boolean;
  reason: "ok" | "no_token" | "not_served" | "already";
};

/**
 * 후보를 화면 행으로 바꾼다. 사유는 하나만 보여준다 — 여러 개를 나열하면
 * 사용자가 무엇부터 고쳐야 할지 모른다. 등록됨 > 토큰 없음 > 서빙 안 함 순으로
 * 우선한다(가장 손댈 게 없는 것부터).
 */
export function toDiscoveryRows(candidates: DiscoveryCandidate[]): DiscoveryRow[] {
  return candidates.map((c) => {
    let reason: DiscoveryRow["reason"] = "ok";
    if (c.alreadyRegistered) reason = "already";
    else if (!c.hasToken) reason = "no_token";
    else if (!c.servedByGateway) reason = "not_served";
    return { ...c, selectable: reason === "ok", reason };
  });
}

export type ProbeStatus = "idle" | "ok" | "not_found" | "unknown";

const PROBE_STATUSES: ProbeStatus[] = ["idle", "ok", "not_found", "unknown"];

/**
 * `POST .../profiles/probe` 응답의 `status` 필드를 화면의 유니온 타입으로 검증한다.
 * 서버가 이 셋 중 하나가 아닌 값을 내려보내면(버전 불일치 등) `"unknown"`으로
 * 접는다 — 검증 없이 그대로 state에 넣으면 i18n 키가 없어 화면이 빈 문자열로
 * 조용히 깨진다.
 */
export function toProbeStatus(value: unknown): ProbeStatus {
  return typeof value === "string" && (PROBE_STATUSES as string[]).includes(value)
    ? (value as ProbeStatus)
    : "unknown";
}

export type RegistrationResult = { name: string; ok: boolean; errorCode?: string };
export type RegistrationFailure = { name: string; errorCode: string };

/**
 * 선택 등록 응답(`{ results }`)을 화면이 쓸 두 조각으로 나눈다.
 *
 * 실패한 이름은 selection에 남긴다 — 사용자가 다시 체크하지 않고 바로 재시도할
 * 수 있어야 한다. errorCode가 없는 실패(응답 모양이 예상과 다른 경우)는
 * "register_failed"로 접어, 화면에 원인 불명 실패가 조용히 사라지지 않게 한다.
 */
export function partitionRegistrationResults(results: RegistrationResult[]): {
  nextSelected: string[];
  failures: RegistrationFailure[];
} {
  const nextSelected: string[] = [];
  const failures: RegistrationFailure[] = [];
  for (const r of results) {
    if (r.ok) continue;
    nextSelected.push(r.name);
    failures.push({ name: r.name, errorCode: r.errorCode ?? "register_failed" });
  }
  return { nextSelected, failures };
}
