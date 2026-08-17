import type { OpenClawPairingStatus } from "./OpenClawPairingStatusCard";

/**
 * 게이트웨이 연결 상태 카드를 띄울지 판단한다.
 *
 * 게이트웨이별 상태를 맵에 담아 두는 화면(/gateways)에서는 아직 연결 테스트를
 * 한 번도 돌리지 않은 게이트웨이의 항목이 아예 없다. 이때 `state?.status !== "idle"`
 * 로 판단하면 `undefined !== "idle"` 이 참이 되어 카드가 떠버리고, 렌더 쪽의
 * `?? "idle"` 폴백 때문에 "아직 연결 테스트를 실행하지 않았습니다" 문구가 노출된다.
 * 상태가 없다는 것과 상태가 idle이라는 것은 둘 다 "보여줄 게 없다"이므로 같이 막는다.
 */
export function shouldShowPairingCard(
  state: { status: OpenClawPairingStatus } | null | undefined,
): boolean {
  if (!state) return false;
  return state.status !== "idle";
}
