"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";

import GroupAccessPanel from "@/components/admin/GroupAccessPanel";
import LocaleSwitcher from "@/components/LocaleSwitcher";
import LogoutButton from "@/components/LogoutButton";
import { useT } from "@/lib/i18n";
import { getLocalizedErrorMessage } from "@/lib/i18n/error-codes";
import type { GroupMemberRole } from "@/lib/rbac/constants";

type GroupRow = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  isDefault: boolean;
  createdBy: string | null;
  role?: GroupMemberRole;
  canCreateChannel?: boolean;
};

export default function AdminGroupsPage() {
  const t = useT();

  return (
    <Suspense
      fallback={
        <div className="theme-web min-h-screen flex items-center justify-center bg-bg text-text">
          {t("common.loading")}
        </div>
      }
    >
      <AdminGroupsPageInner />
    </Suspense>
  );
}

function AdminGroupsPageInner() {
  const t = useT();
  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const manageableGroups = useMemo(
    () => groups.filter((group) => !group.role || group.role === "group_admin"),
    [groups],
  );

  useEffect(() => {
    fetch("/api/groups")
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw data;
        }
        return data;
      })
      .then((data) => {
        const nextGroups = Array.isArray(data.groups) ? data.groups : [];
        setGroups(nextGroups);
        const nextManageableGroups = nextGroups.filter((group) => !group.role || group.role === "group_admin");
        setSelectedGroupId(nextManageableGroups[0]?.id ?? "");
        setLoading(false);
      })
      .catch((nextError) => {
        setError(getLocalizedErrorMessage(t, nextError, "common.error"));
        setLoading(false);
      });
  }, [t]);

  const selectedGroup = useMemo(
    () => manageableGroups.find((group) => group.id === selectedGroupId) ?? null,
    [manageableGroups, selectedGroupId],
  );

  if (loading) {
    return (
      <div className="theme-web min-h-screen flex items-center justify-center bg-bg text-text">
        {t("common.loading")}
      </div>
    );
  }

  return (
    <div className="theme-web min-h-screen bg-bg px-8 py-8 text-text">
      <div className="mx-auto max-w-7xl">
        <div className="mb-8 flex items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold">{t("admin.groups.title")}</h1>
            <p className="mt-1 text-text-muted">{t("admin.groups.subtitle")}</p>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href="/channels"
              className="rounded-lg bg-surface-raised px-4 py-2 text-sm font-medium hover:bg-surface-raised/80"
            >
              {t("admin.groups.backToChannels")}
            </Link>
            <LogoutButton />
            <LocaleSwitcher />
          </div>
        </div>

        {error && (
          <div className="mb-6 rounded-lg border border-danger/40 bg-surface px-4 py-3 text-sm text-danger">
            {error}
          </div>
        )}

        {manageableGroups.length === 0
          ? (
            <div className="rounded-xl border border-border bg-surface px-6 py-10 text-center text-text-muted">
              {t("admin.groups.empty")}
            </div>
          )
          : (
            <div className="grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
              <aside className="rounded-xl border border-border bg-surface p-4">
                <h2 className="mb-3 text-lg font-semibold">{t("admin.groups.manage")}</h2>
                <div className="space-y-2">
                  {manageableGroups.map((group) => (
                    <button
                      key={group.id}
                      type="button"
                      onClick={() => setSelectedGroupId(group.id)}
                      className={`w-full rounded-lg px-3 py-3 text-left transition ${
                        selectedGroupId === group.id
                          ? "bg-primary-muted text-primary-light ring-1 ring-primary-light"
                          : "bg-bg hover:bg-surface-raised"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span className="font-medium">{group.name}</span>
                        {group.role && (
                          <span className="text-xs text-text-muted">{group.role}</span>
                        )}
                      </div>
                      <p className="mt-1 text-xs text-text-muted">
                        {group.canCreateChannel
                          ? t("admin.groups.canCreate")
                          : t("admin.groups.readOnly")}
                      </p>
                    </button>
                  ))}
                </div>
              </aside>

              <main>
                {selectedGroup
                  ? <GroupAccessPanel groupId={selectedGroup.id} groupName={selectedGroup.name} />
                  : null}
              </main>
            </div>
          )}
      </div>
    </div>
  );
}
