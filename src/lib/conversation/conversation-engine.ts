// This file is a thin re-export for call-site compatibility. The real implementation lives in channel-runtime.ts.
//
// meeting-discussion.ts imports from here, and touching that file is out of scope for
// this work. This avoids letting a name cleanup spread the diff into the socket layer.

export { ChannelRuntime as ConversationEngine } from "./channel-runtime";
export type {
  EngineParticipant,
  EngineCallbacks,
  EngineConfig,
  EngineQuota,
  EngineEndReason,
  RunMode,
} from "./channel-runtime";
