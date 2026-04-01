export type MeetingMessageLike = {
  id: string;
  sender: string;
  senderId: string;
  senderType: "user" | "npc";
  content: string;
  timestamp: number;
};

function ensureUniqueMessageId(
  existingMessages: MeetingMessageLike[],
  candidateId: string,
) {
  const existingIds = new Set(existingMessages.map((message) => message.id));
  if (!existingIds.has(candidateId)) {
    return candidateId;
  }

  let suffix = 1;
  let nextId = `${candidateId}-${suffix}`;
  while (existingIds.has(nextId)) {
    suffix += 1;
    nextId = `${candidateId}-${suffix}`;
  }
  return nextId;
}

export function appendMeetingMessage<T extends MeetingMessageLike>(
  existingMessages: T[],
  incomingMessage: T,
  limit = 100,
) {
  const nextMessage = {
    ...incomingMessage,
    id: ensureUniqueMessageId(existingMessages, incomingMessage.id),
  };

  return [...existingMessages, nextMessage].slice(-limit);
}
