import type { MeetingMessageLike } from "./message-state";

export function consumeNpcStreamBuffer(args: {
  streams: Record<string, string>;
  npcId: string;
  fallbackSenderName: string;
  timestamp: number;
  /**
   * Final text the server sent at the end of the turn. If present, used instead of the accumulated
   * stream — the delta can accumulate even a retried earlier generation, so finalizing from the
   * buffer would make the screen diverge from the meeting record.
   */
  finalText?: string;
}): {
  nextStreams: Record<string, string>;
  finalizedMessage: MeetingMessageLike | null;
} {
  const { streams, npcId, fallbackSenderName, timestamp, finalText } = args;
  const content = typeof finalText === "string" && finalText ? finalText : streams[npcId];
  const nextStreams = { ...streams };
  delete nextStreams[npcId];

  if (!content) {
    return {
      nextStreams,
      finalizedMessage: null,
    };
  }

  return {
    nextStreams,
    finalizedMessage: {
      id: `msg-${timestamp}-${npcId}`,
      sender: fallbackSenderName,
      senderId: `npc-${npcId}`,
      senderType: "npc",
      content,
      timestamp,
    },
  };
}
