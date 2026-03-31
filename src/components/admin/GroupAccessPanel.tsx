"use client";

import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";

import { PERMISSION_KEYS, type GroupMemberRole, type PermissionKey } from "@/lib/rbac/constants";
import { useT } from "@/lib/i18n";
import { getLocalizedErrorMessage } from "@/lib/i18n/error-codes";

type MemberRow = {
  userId: string;
  role: GroupMemberRole;
  approvedBy: string | null;
  approvedAt: string | null;
  joinedAt: string | null;
  loginId: string;
  nickname: string;
};

type InviteRow = {
  id: string;
  token: string;
  createdBy: string | null;
  targetUserId: string | null;
  targetLoginId: string | null;
  expiresAt: string | null;
  acceptedBy: string | null;
  acceptedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  targetNickname: string | null;
};

type JoinRequestRow = {
  id: string;
  userId: string;
  status: "pending" | "approved" | "rejected";
  message: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
  loginId: string;
  nickname: string;
};

type PermissionRow = {
  id: string;
  permissionKey: PermissionKey;
  effect: "allow" | "deny";
  createdBy: string | null;
  createdAt: string;
};

type OverrideRow = {
  id: string;
  userId: string;
  permissionKey: PermissionKey;
  effect: "allow" | "deny";
  createdBy: string | null;
  createdAt: string;
  loginId: string;
  nickname: string;
};

type SectionState<T> = {
  items: T[];
  loading: boolean;
  error: string;
};

const EMPTY_SECTION = { loading: true, error: "" } as const;

function buildInitialPermissionDraft() {
  return Object.fromEntries(
    PERMISSION_KEYS.map((permissionKey) => [permissionKey, "inherit"]),
  ) as Record<PermissionKey, "inherit" | "allow" | "deny">;
}

async function readJsonOrThrow(response: Response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw data;
  }
  return data;
}

type GroupAccessPanelProps = {
  groupId: string;
  groupName: string;
};

export default function GroupAccessPanel({
  groupId,
  groupName,
}: GroupAccessPanelProps) {
  const t = useT();

  const [members, setMembers] = useState<SectionState<MemberRow>>({
    items: [],
    ...EMPTY_SECTION,
  });
  const [invites, setInvites] = useState<SectionState<InviteRow>>({
    items: [],
    ...EMPTY_SECTION,
  });
  const [joinRequests, setJoinRequests] = useState<SectionState<JoinRequestRow>>({
    items: [],
    ...EMPTY_SECTION,
  });
  const [permissions, setPermissions] = useState<SectionState<PermissionRow>>({
    items: [],
    ...EMPTY_SECTION,
  });
  const [overrides, setOverrides] = useState<SectionState<OverrideRow>>({
    items: [],
    ...EMPTY_SECTION,
  });

  const [memberLoginId, setMemberLoginId] = useState("");
  const [memberRole, setMemberRole] = useState<GroupMemberRole>("member");
  const [inviteLoginId, setInviteLoginId] = useState("");
  const [inviteExpiresAt, setInviteExpiresAt] = useState("");
  const [overrideTargetUserId, setOverrideTargetUserId] = useState("");
  const [overridePermissionKey, setOverridePermissionKey] = useState<PermissionKey>("create_channel");
  const [overrideEffect, setOverrideEffect] = useState<"allow" | "deny" | "inherit">("allow");
  const [permissionDraft, setPermissionDraft] = useState(buildInitialPermissionDraft);
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [flashMessage, setFlashMessage] = useState("");

  const showError = useCallback((payload: unknown, fallbackKey = "common.error") => {
    setFlashMessage(getLocalizedErrorMessage(t, payload, fallbackKey));
  }, [t]);

  const loadSection = useCallback(async <T,>(
    url: string,
    key: string,
  ): Promise<{ items: T[]; error: string }> => {
    try {
      const data = await readJsonOrThrow(await fetch(url));
      return { items: (data[key] as T[]) || [], error: "" };
    } catch (error) {
      return {
        items: [],
        error: getLocalizedErrorMessage(t, error, "common.error"),
      };
    }
  }, [t]);

  const refreshAll = useCallback(async () => {
    setMembers((current) => ({ ...current, loading: true, error: "" }));
    setInvites((current) => ({ ...current, loading: true, error: "" }));
    setJoinRequests((current) => ({ ...current, loading: true, error: "" }));
    setPermissions((current) => ({ ...current, loading: true, error: "" }));
    setOverrides((current) => ({ ...current, loading: true, error: "" }));

    const [
      nextMembers,
      nextInvites,
      nextJoinRequests,
      nextPermissions,
      nextOverrides,
    ] = await Promise.all([
      loadSection<MemberRow>(`/api/groups/${groupId}/members`, "members"),
      loadSection<InviteRow>(`/api/groups/${groupId}/invites`, "invites"),
      loadSection<JoinRequestRow>(`/api/groups/${groupId}/join-requests`, "joinRequests"),
      loadSection<PermissionRow>(`/api/groups/${groupId}/permissions`, "permissions"),
      loadSection<OverrideRow>(`/api/groups/${groupId}/user-overrides`, "overrides"),
    ]);

    setMembers({ ...nextMembers, loading: false });
    setInvites({ ...nextInvites, loading: false });
    setJoinRequests({ ...nextJoinRequests, loading: false });
    setPermissions({ ...nextPermissions, loading: false });
    setOverrides({ ...nextOverrides, loading: false });
  }, [groupId, loadSection]);

  useEffect(() => {
    setPermissionDraft(buildInitialPermissionDraft());
    setOverrideTargetUserId("");
    setFlashMessage("");
    void refreshAll();
  }, [groupId, refreshAll]);

  useEffect(() => {
    setPermissionDraft((current) => {
      const nextDraft = buildInitialPermissionDraft();
      for (const permission of permissions.items) {
        nextDraft[permission.permissionKey] = permission.effect;
      }

      const changed = PERMISSION_KEYS.some((permissionKey) => current[permissionKey] !== nextDraft[permissionKey]);
      return changed ? nextDraft : current;
    });
  }, [permissions.items]);

  useEffect(() => {
    setOverrideTargetUserId((current) => current || members.items[0]?.userId || "");
  }, [members.items]);

  const groupedOverrides = useMemo(() => {
    return overrides.items.reduce<Record<string, OverrideRow[]>>((acc, row) => {
      const key = row.userId;
      if (!acc[key]) acc[key] = [];
      acc[key].push(row);
      return acc;
    }, {});
  }, [overrides.items]);

  const submitAction = useCallback(async (
    actionKey: string,
    work: () => Promise<void>,
  ) => {
    setSubmitting(actionKey);
    setFlashMessage("");
    try {
      await work();
      await refreshAll();
    } catch (error) {
      showError(error);
    } finally {
      setSubmitting(null);
    }
  }, [refreshAll, showError]);

  const sectionCard = (title: string, content: ReactNode) => (
    <section className="rounded-xl border border-border bg-surface p-4">
      <h3 className="mb-4 text-lg font-semibold">{title}</h3>
      {content}
    </section>
  );

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border bg-surface p-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-2xl font-bold">{groupName}</h2>
            <p className="mt-1 text-sm text-text-muted">
              {t("admin.groups.subtitle")}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void refreshAll()}
            className="rounded-lg bg-surface-raised px-3 py-2 text-sm font-medium hover:bg-surface-raised/80"
          >
            {t("admin.groups.refresh")}
          </button>
        </div>
        {flashMessage && (
          <p className="mt-3 text-sm text-danger">{flashMessage}</p>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {sectionCard(
          t("admin.groups.members"),
          <div className="space-y-4">
            <form
              className="flex flex-col gap-2 sm:flex-row"
              onSubmit={(event) => {
                event.preventDefault();
                if (!memberLoginId.trim()) return;
                void submitAction("member-add", async () => {
                  await readJsonOrThrow(await fetch(`/api/groups/${groupId}/members`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      targetLoginId: memberLoginId.trim(),
                      role: memberRole,
                    }),
                  }));
                  setMemberLoginId("");
                });
              }}
            >
              <input
                value={memberLoginId}
                onChange={(event) => setMemberLoginId(event.target.value)}
                placeholder={t("admin.groups.targetLoginId")}
                className="flex-1 rounded-lg border border-border bg-bg px-3 py-2"
              />
              <select
                value={memberRole}
                onChange={(event) => setMemberRole(event.target.value as GroupMemberRole)}
                className="rounded-lg border border-border bg-bg px-3 py-2"
              >
                <option value="member">member</option>
                <option value="group_admin">group_admin</option>
              </select>
              <button
                type="submit"
                disabled={submitting === "member-add"}
                className="rounded-lg bg-primary px-3 py-2 font-medium text-white disabled:opacity-60"
              >
                {t("admin.groups.addMember")}
              </button>
            </form>
            {members.loading
              ? <p className="text-sm text-text-muted">{t("admin.groups.loading")}</p>
              : members.error
              ? <p className="text-sm text-danger">{members.error}</p>
              : members.items.length === 0
              ? <p className="text-sm text-text-muted">{t("admin.groups.noData")}</p>
              : (
                <div className="space-y-2">
                  {members.items.map((member) => (
                    <div key={member.userId} className="flex items-center justify-between rounded-lg bg-bg px-3 py-2">
                      <div>
                        <p className="font-medium">{member.nickname || member.loginId}</p>
                        <p className="text-xs text-text-muted">{member.loginId} · {member.role}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => void submitAction(`member-remove-${member.userId}`, async () => {
                          await readJsonOrThrow(await fetch(`/api/groups/${groupId}/members`, {
                            method: "DELETE",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ targetUserId: member.userId }),
                          }));
                        })}
                        className="text-sm text-danger"
                      >
                        {t("admin.groups.remove")}
                      </button>
                    </div>
                  ))}
                </div>
              )}
          </div>,
        )}

        {sectionCard(
          t("admin.groups.invites"),
          <div className="space-y-4">
            <form
              className="grid gap-2 sm:grid-cols-[1fr_220px_auto]"
              onSubmit={(event) => {
                event.preventDefault();
                if (!inviteLoginId.trim()) return;
                void submitAction("invite-create", async () => {
                  await readJsonOrThrow(await fetch(`/api/groups/${groupId}/invites`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      targetLoginId: inviteLoginId.trim(),
                      expiresAt: inviteExpiresAt ? new Date(inviteExpiresAt).toISOString() : null,
                    }),
                  }));
                  setInviteLoginId("");
                  setInviteExpiresAt("");
                });
              }}
            >
              <input
                value={inviteLoginId}
                onChange={(event) => setInviteLoginId(event.target.value)}
                placeholder={t("admin.groups.targetLoginId")}
                className="rounded-lg border border-border bg-bg px-3 py-2"
              />
              <input
                type="datetime-local"
                value={inviteExpiresAt}
                onChange={(event) => setInviteExpiresAt(event.target.value)}
                className="rounded-lg border border-border bg-bg px-3 py-2"
              />
              <button
                type="submit"
                disabled={submitting === "invite-create"}
                className="rounded-lg bg-primary px-3 py-2 font-medium text-white disabled:opacity-60"
              >
                {t("admin.groups.createInvite")}
              </button>
            </form>
            {invites.loading
              ? <p className="text-sm text-text-muted">{t("admin.groups.loading")}</p>
              : invites.error
              ? <p className="text-sm text-danger">{invites.error}</p>
              : invites.items.length === 0
              ? <p className="text-sm text-text-muted">{t("admin.groups.noData")}</p>
              : (
                <div className="space-y-2">
                  {invites.items.map((invite) => (
                    <div key={invite.id} className="flex items-center justify-between rounded-lg bg-bg px-3 py-2">
                      <div>
                        <p className="font-medium">{invite.targetNickname || invite.targetLoginId || invite.token.slice(0, 8)}</p>
                        <p className="text-xs text-text-muted">
                          {invite.revokedAt ? "revoked" : invite.acceptedAt ? "accepted" : "active"}
                          {invite.expiresAt ? ` · ${new Date(invite.expiresAt).toLocaleString()}` : ""}
                        </p>
                      </div>
                      {!invite.revokedAt && !invite.acceptedAt && (
                        <button
                          type="button"
                          onClick={() => void submitAction(`invite-revoke-${invite.id}`, async () => {
                            await readJsonOrThrow(await fetch(`/api/groups/${groupId}/invites`, {
                              method: "DELETE",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ inviteId: invite.id }),
                            }));
                          })}
                          className="text-sm text-danger"
                        >
                          {t("admin.groups.revokeInvite")}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
          </div>,
        )}

        {sectionCard(
          t("admin.groups.joinRequests"),
          <div className="space-y-2">
            {joinRequests.loading
              ? <p className="text-sm text-text-muted">{t("admin.groups.loading")}</p>
              : joinRequests.error
              ? <p className="text-sm text-danger">{joinRequests.error}</p>
              : joinRequests.items.length === 0
              ? <p className="text-sm text-text-muted">{t("admin.groups.noData")}</p>
              : joinRequests.items.map((request) => (
                <div key={request.id} className="rounded-lg bg-bg px-3 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="font-medium">{request.nickname || request.loginId}</p>
                      <p className="text-xs text-text-muted">{request.loginId}</p>
                    </div>
                    {request.status === "pending" && (
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => void submitAction(`request-approve-${request.id}`, async () => {
                            await readJsonOrThrow(await fetch(`/api/groups/${groupId}/join-requests`, {
                              method: "PATCH",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ requestId: request.id, action: "approve" }),
                            }));
                          })}
                          className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-white"
                        >
                          {t("admin.groups.approve")}
                        </button>
                        <button
                          type="button"
                          onClick={() => void submitAction(`request-reject-${request.id}`, async () => {
                            await readJsonOrThrow(await fetch(`/api/groups/${groupId}/join-requests`, {
                              method: "PATCH",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ requestId: request.id, action: "reject" }),
                            }));
                          })}
                          className="rounded-lg bg-surface-raised px-3 py-1.5 text-sm font-medium"
                        >
                          {t("admin.groups.reject")}
                        </button>
                      </div>
                    )}
                  </div>
                  {request.message && (
                    <p className="mt-2 text-sm text-text-muted">{request.message}</p>
                  )}
                </div>
              ))}
          </div>,
        )}

        {sectionCard(
          t("admin.groups.permissions"),
          <div className="space-y-3">
            {permissions.loading
              ? <p className="text-sm text-text-muted">{t("admin.groups.loading")}</p>
              : permissions.error
              ? <p className="text-sm text-danger">{permissions.error}</p>
              : PERMISSION_KEYS.map((permissionKey) => (
                <div key={permissionKey} className="flex flex-col gap-2 rounded-lg bg-bg px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <span className="text-sm font-medium">{permissionKey}</span>
                  <div className="flex gap-2">
                    <select
                      value={permissionDraft[permissionKey]}
                      onChange={(event) => setPermissionDraft((current) => ({
                        ...current,
                        [permissionKey]: event.target.value as "inherit" | "allow" | "deny",
                      }))}
                      className="rounded-lg border border-border bg-surface px-3 py-2 text-sm"
                    >
                      <option value="inherit">inherit</option>
                      <option value="allow">allow</option>
                      <option value="deny">deny</option>
                    </select>
                    <button
                      type="button"
                      onClick={() => void submitAction(`permission-${permissionKey}`, async () => {
                        await readJsonOrThrow(await fetch(`/api/groups/${groupId}/permissions`, {
                          method: "PUT",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({
                            permissionKey,
                            effect: permissionDraft[permissionKey] === "inherit" ? null : permissionDraft[permissionKey],
                          }),
                        }));
                      })}
                      className="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white"
                    >
                      {t("admin.groups.savePermission")}
                    </button>
                  </div>
                </div>
              ))}
          </div>,
        )}

        {sectionCard(
          t("admin.groups.userOverrides"),
          <div className="space-y-4">
            <form
              className="grid gap-2 md:grid-cols-[1fr_1fr_140px_auto]"
              onSubmit={(event) => {
                event.preventDefault();
                if (!overrideTargetUserId) return;
                void submitAction("override-save", async () => {
                  await readJsonOrThrow(await fetch(`/api/groups/${groupId}/user-overrides`, {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      targetUserId: overrideTargetUserId,
                      permissionKey: overridePermissionKey,
                      effect: overrideEffect === "inherit" ? null : overrideEffect,
                    }),
                  }));
                });
              }}
            >
              <select
                value={overrideTargetUserId}
                onChange={(event) => setOverrideTargetUserId(event.target.value)}
                className="rounded-lg border border-border bg-bg px-3 py-2"
              >
                {members.items.map((member) => (
                  <option key={member.userId} value={member.userId}>
                    {member.nickname || member.loginId}
                  </option>
                ))}
              </select>
              <select
                value={overridePermissionKey}
                onChange={(event) => setOverridePermissionKey(event.target.value as PermissionKey)}
                className="rounded-lg border border-border bg-bg px-3 py-2"
              >
                {PERMISSION_KEYS.map((permissionKey) => (
                  <option key={permissionKey} value={permissionKey}>
                    {permissionKey}
                  </option>
                ))}
              </select>
              <select
                value={overrideEffect}
                onChange={(event) => setOverrideEffect(event.target.value as "allow" | "deny" | "inherit")}
                className="rounded-lg border border-border bg-bg px-3 py-2"
              >
                <option value="inherit">inherit</option>
                <option value="allow">allow</option>
                <option value="deny">deny</option>
              </select>
              <button
                type="submit"
                disabled={!overrideTargetUserId || submitting === "override-save"}
                className="rounded-lg bg-primary px-3 py-2 font-medium text-white disabled:opacity-60"
              >
                {t("admin.groups.saveOverride")}
              </button>
            </form>
            {overrides.loading
              ? <p className="text-sm text-text-muted">{t("admin.groups.loading")}</p>
              : overrides.error
              ? <p className="text-sm text-danger">{overrides.error}</p>
              : Object.keys(groupedOverrides).length === 0
              ? <p className="text-sm text-text-muted">{t("admin.groups.noData")}</p>
              : (
                <div className="space-y-3">
                  {Object.entries(groupedOverrides).map(([userId, userOverrides]) => (
                    <div key={userId} className="rounded-lg bg-bg px-3 py-3">
                      <p className="mb-2 font-medium">
                        {userOverrides[0]?.nickname || userOverrides[0]?.loginId}
                      </p>
                      <div className="space-y-2">
                        {userOverrides.map((override) => (
                          <div key={override.id} className="flex items-center justify-between text-sm">
                            <span>{override.permissionKey}: {override.effect}</span>
                            <button
                              type="button"
                              onClick={() => void submitAction(`override-remove-${override.id}`, async () => {
                                await readJsonOrThrow(await fetch(`/api/groups/${groupId}/user-overrides`, {
                                  method: "PUT",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({
                                    targetUserId: override.userId,
                                    permissionKey: override.permissionKey,
                                    effect: null,
                                  }),
                                }));
                              })}
                              className="text-danger"
                            >
                              {t("admin.groups.remove")}
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
          </div>,
        )}
      </div>
    </div>
  );
}
