export type ChannelJoinAccessReason =
  | "channel_member"
  | "group_member"
  | "groupless_public_browse_only"
  | "group_membership_required";

export function summarizeChannelJoinAccess(args: {
  isPublic: boolean;
  hasActiveGroupMembership: boolean;
  isChannelMember: boolean;
}) {
  if (args.isChannelMember) {
    return { allowed: true, reason: "channel_member" as const };
  }

  if (args.isPublic && !args.hasActiveGroupMembership) {
    return { allowed: false, reason: "groupless_public_browse_only" as const };
  }

  return {
    allowed: args.hasActiveGroupMembership,
    reason: args.hasActiveGroupMembership
      ? ("group_member" as const)
      : ("group_membership_required" as const),
  };
}
