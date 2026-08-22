// 건너뛴 지목을 사용자에게 어떤 문구로 알릴지 고르는 표.
//
// 이 파일이 존재하는 이유는 삼항 연산자 하나를 대신하기 위해서가 아니라, **사유가 늘 때
// 컴파일러가 막아 주게** 하기 위해서다. 원래 코드는 이랬다:
//
//   const key = reason === "backend_failing" ? "...backendFailing" : "...quotaExhausted";
//
// 이 모양은 유니온에 세 번째 사유(예: "seat_vacated")가 추가돼도 조용히 통과하면서
// 그것을 "발언 할당량을 다 썼다"고 표시한다 — 엔진이 애써 구분해 보낸 사실을 마지막
// 한 칸에서 뭉개는 것이다. `satisfies Record<MentionSkipReason, string>` 는 그 순간
// 타입 에러를 낸다.
//
// 문구 자체는 여기 없다. 엔진도 서버도 문구를 만들지 않고 (npcId, reason) 만 나른다 —
// 표시는 i18n 로케일(ko/ja/zh/en)의 몫이다.

import type { MentionSkipReason } from "@/lib/conversation/floor-controller";

export const MENTION_SKIP_I18N_KEY = {
  quota_exhausted: "meeting.mentionSkipped.quotaExhausted",
  backend_failing: "meeting.mentionSkipped.backendFailing",
} as const satisfies Record<MentionSkipReason, string>;

export function mentionSkipI18nKey(reason: MentionSkipReason): string {
  return MENTION_SKIP_I18N_KEY[reason];
}
