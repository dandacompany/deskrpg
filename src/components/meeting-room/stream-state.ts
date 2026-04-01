import type { MeetingMessageLike } from "./message-state";

export function consumeNpcStreamBuffer(args: {
  streams: Record<string, string>;
  npcId: string;
  fallbackSenderName: string;
  timestamp: number;
}): {
  nextStreams: Record<string, string>;
  finalizedMessage: MeetingMessageLike | null;
} {
  const { streams, npcId, fallbackSenderName, timestamp } = args;
  const content = streams[npcId];
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
