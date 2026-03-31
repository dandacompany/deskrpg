export const PERMISSION_KEYS = [
  "create_channel",
  "manage_group_members",
  "manage_group_permissions",
  "approve_join_requests",
  "manage_group_channels",
] as const;

export const SYSTEM_ROLES = ["system_admin", "user"] as const;

export const GROUP_MEMBER_ROLES = ["group_admin", "member"] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];
export type SystemRole = (typeof SYSTEM_ROLES)[number];
export type GroupMemberRole = (typeof GROUP_MEMBER_ROLES)[number];
