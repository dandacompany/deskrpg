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
