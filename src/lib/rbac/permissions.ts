import type { GroupMemberRole, PermissionKey, SystemRole } from "./constants";

export type PermissionEffect = "allow" | "deny";

export type PermissionDecisionReason =
  | "system_role"
  | "group_role"
  | "group_allow"
  | "group_deny"
  | "user_allow"
  | "user_deny"
  | "default_deny";

export type ResolvePermissionInput = {
  systemRole: SystemRole;
  groupRole: GroupMemberRole;
  permissionKey: PermissionKey;
  groupEffects: PermissionEffect[];
  userEffects: PermissionEffect[];
};

export type PermissionDecision = {
  allowed: boolean;
  reason: PermissionDecisionReason;
};

const GROUP_ADMIN_IMPLICIT_PERMISSIONS = new Set<PermissionKey>([
  "create_channel",
  "manage_group_members",
  "manage_group_permissions",
  "approve_join_requests",
  "manage_group_channels",
]);

export function resolvePermission(input: ResolvePermissionInput): PermissionDecision {
  if (input.userEffects.includes("deny")) {
    return { allowed: false, reason: "user_deny" };
  }

  let decision: PermissionDecision = { allowed: false, reason: "default_deny" };

  if (input.systemRole === "system_admin") {
    decision = { allowed: true, reason: "system_role" };
  } else if (
    input.groupRole === "group_admin" &&
    GROUP_ADMIN_IMPLICIT_PERMISSIONS.has(input.permissionKey)
  ) {
    decision = { allowed: true, reason: "group_role" };
  }

  if (input.groupEffects.includes("deny")) {
    decision = { allowed: false, reason: "group_deny" };
  } else if (input.groupEffects.includes("allow")) {
    decision = { allowed: true, reason: "group_allow" };
  }

  if (input.userEffects.includes("allow")) {
    decision = { allowed: true, reason: "user_allow" };
  }

  return decision;
}
