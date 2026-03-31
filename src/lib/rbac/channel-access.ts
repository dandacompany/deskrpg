export type ChannelCreateAccessReason =
  | "group_member"
  | "group_membership_required"
  | "channel_creation_forbidden";

export type ChannelJoinAccessReason =
  | "group_member"
  | "groupless_public_browse_only"
  | "group_membership_required"
  | "legacy_public_channel"
  | "legacy_private_channel";

export type ChannelDetailAccessReason =
  | "group_member"
  | "groupless_public_browse_only"
  | "group_membership_required"
  | "legacy_public_channel"
  | "legacy_channel_member"
  | "legacy_private_password_required";

export type ChannelParticipationAccessReason =
  | "group_member"
  | "groupless_public_browse_only"
  | "group_membership_required"
  | "legacy_public_channel"
  | "legacy_channel_member"
  | "password_required"
  | "legacy_private_password_required";

export function summarizeChannelCreateAccess(args: {
  hasActiveGroupMembership: boolean;
  permissionAllowed: boolean;
}) {
  if (!args.hasActiveGroupMembership) {
    return { allowed: false, reason: "group_membership_required" as const };
  }

  if (!args.permissionAllowed) {
    return { allowed: false, reason: "channel_creation_forbidden" as const };
  }

  return { allowed: true, reason: "group_member" as const };
}

export function summarizeChannelJoinAccess(args: {
  groupId: string | null;
  isPublic: boolean;
  hasActiveGroupMembership: boolean;
}) {
  if (!args.groupId) {
    return {
      allowed: true,
      reason: args.isPublic ? ("legacy_public_channel" as const) : ("legacy_private_channel" as const),
    };
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

export function summarizeChannelDetailAccess(args: {
  groupId: string | null;
  isPublic: boolean;
  hasActiveGroupMembership: boolean;
  isChannelMember: boolean;
}) {
  if (!args.groupId) {
    if (args.isChannelMember) {
      return { allowed: true, requiresPassword: false, reason: "legacy_channel_member" as const };
    }

    if (args.isPublic) {
      return { allowed: true, requiresPassword: false, reason: "legacy_public_channel" as const };
    }

    return { allowed: false, requiresPassword: true, reason: "legacy_private_password_required" as const };
  }

  if (args.isPublic && !args.hasActiveGroupMembership) {
    return { allowed: true, requiresPassword: false, reason: "groupless_public_browse_only" as const };
  }

  if (!args.hasActiveGroupMembership) {
    return { allowed: false, requiresPassword: false, reason: "group_membership_required" as const };
  }

  return {
    allowed: true,
    requiresPassword: !args.isPublic && !args.isChannelMember,
    reason: "group_member" as const,
  };
}

export function summarizeChannelParticipationAccess(args: {
  groupId: string | null;
  isPublic: boolean;
  hasActiveGroupMembership: boolean;
  isChannelMember: boolean;
}) {
  if (!args.groupId) {
    if (args.isPublic) {
      return { allowed: true, reason: "legacy_public_channel" as const };
    }

    return args.isChannelMember
      ? { allowed: true, reason: "legacy_channel_member" as const }
      : { allowed: false, reason: "legacy_private_password_required" as const };
  }

  if (!args.hasActiveGroupMembership) {
    return {
      allowed: false,
      reason: args.isPublic
        ? ("groupless_public_browse_only" as const)
        : ("group_membership_required" as const),
    };
  }

  if (!args.isPublic && !args.isChannelMember) {
    return { allowed: false, reason: "password_required" as const };
  }

  return { allowed: true, reason: "group_member" as const };
}
