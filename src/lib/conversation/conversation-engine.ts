// 이 파일은 호출부 호환을 위한 얇은 재export 다. 실체는 channel-runtime.ts 에 있다.
//
// meeting-discussion.ts 가 여기서 import 하고 있고, 그 파일을 건드리는 것은 이번 작업의
// 범위가 아니다. 이름을 정리하려고 소켓 계층까지 diff 를 번지게 하지 않는다.

export { ChannelRuntime as ConversationEngine } from "./channel-runtime";
export type {
  EngineParticipant,
  EngineCallbacks,
  EngineConfig,
  EngineQuota,
  EngineEndReason,
  RunMode,
} from "./channel-runtime";
