export type BootstrapActions = {
  systemRole: "system_admin" | "user";
  createDefaultGroup: boolean;
  defaultGroup?: {
    name: string;
    slug: string;
    description: string;
    isDefault: true;
  };
  groupMembership: {
    userId: string;
    role: "group_admin";
  } | null;
};

export type BootstrapCompletion = {
  systemRole: "system_admin" | "user";
  createGroupMembership: boolean;
};

export function buildBootstrapActions({
  existingUserCount,
  userId,
  loginId,
}: {
  existingUserCount: number;
  userId: string;
  loginId: string;
}): BootstrapActions {
  if (existingUserCount > 0) {
    return {
      systemRole: "user",
      createDefaultGroup: false,
      groupMembership: null,
    };
  }

  return {
    systemRole: "system_admin",
    createDefaultGroup: true,
    defaultGroup: {
      name: "Default",
      slug: "default",
      description: `${loginId}'s default workspace`,
      isDefault: true,
    },
    groupMembership: {
      userId,
      role: "group_admin",
    },
  };
}

export function resolveBootstrapCompletion({
  bootstrap,
  defaultGroupCreated,
}: {
  bootstrap: BootstrapActions;
  defaultGroupCreated: boolean;
}): BootstrapCompletion {
  if (
    bootstrap.createDefaultGroup &&
    bootstrap.defaultGroup &&
    bootstrap.groupMembership &&
    defaultGroupCreated
  ) {
    return {
      systemRole: "system_admin",
      createGroupMembership: true,
    };
  }

  return {
    systemRole: "user",
    createGroupMembership: false,
  };
}
