/**
 * Who requested the approval. The single `approvals.requested_by` column holds two kinds.
 *
 * - A batch a staff member started (e.g. a card proposal mid-conversation) → the profile name as-is.
 * - A batch a human started (e.g. registering a meeting) → `user:<id>`.
 *
 * The prefix is unambiguous because Hermes profile names match `^[a-z0-9][a-z0-9_-]{0,63}$`
 * (`src/lib/hermes/setup/host.ts:132`) — **colons can't appear in them.** So splitting on the
 * first colon can never misread a profile name as a human.
 */
export type ApprovalRequester =
  { kind: "profile"; profileName: string } | { kind: "user"; userId: string };

const USER_PREFIX = "user:";

export function formatRequester(requester: ApprovalRequester): string {
  return requester.kind === "user" ? `${USER_PREFIX}${requester.userId}` : requester.profileName;
}

export function parseRequester(stored: string): ApprovalRequester {
  return stored.startsWith(USER_PREFIX)
    ? { kind: "user", userId: stored.slice(USER_PREFIX.length) }
    : { kind: "profile", profileName: stored };
}
