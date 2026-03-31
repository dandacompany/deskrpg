"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import PasswordModal from "@/components/PasswordModal";
import { useT } from "@/lib/i18n";
import { getLocalizedErrorMessage } from "@/lib/i18n/error-codes";
import LocaleSwitcher from "@/components/LocaleSwitcher";
import LogoutButton from "@/components/LogoutButton";
import { Lock, X } from "lucide-react";
import type { GroupMemberRole } from "@/lib/rbac/constants";

interface Channel {
  id: string;
  name: string;
  description: string | null;
  ownerId: string;
  ownerNickname: string | null;
  isPublic: boolean;
  isLocked: boolean;
  isMember: boolean;
  inviteCode: string | null;
  maxPlayers: number;
  playerCount: number;
  createdAt: string;
  canJoin?: boolean;
  requiresGroupMembership?: boolean;
  requiresPassword?: boolean;
  groupId?: string | null;
  groupName?: string | null;
  joinAccessReason?: string | null;
}

interface GroupOption {
  id: string;
  name: string;
  role?: GroupMemberRole;
}

export default function ChannelsPage() {
  return (
    <Suspense
      fallback={
        <div className="theme-web min-h-screen flex items-center justify-center bg-bg text-text">
          Loading...
        </div>
      }
    >
      <ChannelsPageInner />
    </Suspense>
  );
}

function ChannelsPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const characterId = searchParams.get("characterId");
  const t = useT();

  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [joinCode, setJoinCode] = useState("");
  const [joinError, setJoinError] = useState("");
  const [passwordChannel, setPasswordChannel] = useState<Channel | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [availableGroups, setAvailableGroups] = useState<GroupOption[]>([]);

  useEffect(() => {
    if (!characterId) {
      router.push("/characters");
      return;
    }

    Promise.all([
      fetch("/api/channels").then((res) => res.json()),
      fetch("/api/groups")
        .then((res) => (res.ok ? res.json() : { groups: [] }))
        .catch(() => ({ groups: [] })),
    ])
      .then(([channelData, groupData]) => {
        setChannels(channelData.channels || []);
        setCurrentUserId(channelData.currentUserId || null);
        setAvailableGroups(groupData.groups || []);
        setLoading(false);
      })
      .catch(() => {
        setLoading(false);
      });
  }, [characterId, router]);

  const handleDeleteChannel = async (e: React.MouseEvent, channelId: string) => {
    e.stopPropagation();
    if (!confirm(t("channels.deleteConfirm"))) return;
    try {
      const res = await fetch(`/api/channels/${channelId}`, { method: "DELETE" });
      if (res.ok) {
        setChannels((prev) => prev.filter((c) => c.id !== channelId));
      }
    } catch {
      // ignore
    }
  };

  const handleChannelClick = (channel: Channel) => {
    if (channel.canJoin === false) {
      if (channel.requiresGroupMembership) {
        setJoinError(t("channels.browseOnlyHint"));
      } else if (channel.joinAccessReason) {
        setJoinError(
          getLocalizedErrorMessage(
            t,
            { errorCode: channel.joinAccessReason },
            "errors.forbidden",
          ),
        );
      }
      return;
    }

    if ((channel.requiresPassword ?? channel.isLocked) && !channel.isMember) {
      setPasswordChannel(channel);
    } else {
      router.push(`/game?channelId=${channel.id}&characterId=${characterId}`);
    }
  };

  const handlePasswordSubmit = async (password: string): Promise<boolean> => {
    if (!passwordChannel) return false;
    try {
      const res = await fetch(`/api/channels/${passwordChannel.id}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) return false;
      router.push(`/game?channelId=${passwordChannel.id}&characterId=${characterId}`);
      return true;
    } catch {
      return false;
    }
  };

  const handleJoinByCode = async () => {
    if (!joinCode.trim()) return;
    setJoinError("");

    try {
      const res = await fetch(`/api/channels/join/${joinCode.trim()}`);
      const data = await res.json();

      if (!res.ok) {
        setJoinError(getLocalizedErrorMessage(t, data, "channels.invalidInvite"));
        return;
      }

      router.push(`/game?channelId=${data.channel.id}&characterId=${characterId}`);
    } catch {
      setJoinError(t("channels.joinFailed"));
    }
  };

  const canCreateChannels = availableGroups.length > 0;

  if (loading) {
    return (
      <div className="theme-web min-h-screen flex items-center justify-center bg-bg text-text">
        {t("channels.loadingChannels")}
      </div>
    );
  }

  return (
    <div className="theme-web min-h-screen bg-bg text-text p-8">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold">{t("channels.title")}</h1>
            <p className="text-text-muted mt-1">
              {t("channels.subtitle")}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <LogoutButton />
            <LocaleSwitcher />
            {canCreateChannels
              ? (
                <Link
                  href={`/channels/create?characterId=${characterId}`}
                  className="px-4 py-2 bg-primary hover:bg-primary-hover rounded font-semibold"
                >
                  {t("channels.createChannel")}
                </Link>
              )
              : (
                <button
                  type="button"
                  disabled
                  className="px-4 py-2 bg-surface-raised text-text-dim rounded font-semibold opacity-60 cursor-not-allowed"
                  title={t("channels.create.unavailableHint")}
                >
                  {t("channels.createChannel")}
                </button>
              )}
          </div>
        </div>

        {!canCreateChannels && (
          <div className="mb-6 rounded-lg border border-border bg-surface px-4 py-3 text-sm text-text-muted">
            {t("channels.create.unavailableHint")}
          </div>
        )}

        {/* Join by code */}
        <div className="mb-8 flex gap-2 items-center">
          <input
            type="text"
            placeholder={t("channels.inviteCodePlaceholder")}
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleJoinByCode()}
            className="px-3 py-2 bg-surface border border-border rounded text-text placeholder-text-dim focus:outline-none focus:ring-2 focus:ring-primary-light focus:border-transparent w-60"
          />
          <button
            onClick={handleJoinByCode}
            className="px-4 py-2 bg-surface-raised hover:bg-surface-raised/80 rounded font-semibold"
          >
            {t("common.join")}
          </button>
          {joinError && (
            <span className="text-danger text-sm ml-2">{joinError}</span>
          )}
        </div>

        {/* Channel grid */}
        {channels.length === 0 ? (
          <div className="text-center py-20">
            <p className="text-text-muted mb-4">{t("channels.noChannels")}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {channels.map((channel) => (
              <div
                key={channel.id}
                onClick={() => handleChannelClick(channel)}
                className={`bg-surface p-5 rounded-lg transition-all ${
                  channel.canJoin === false
                    ? "cursor-default ring-1 ring-border"
                    : "cursor-pointer hover:ring-2 hover:ring-primary"
                }`}
              >
                <div className="flex items-center gap-2 mb-1">
                  {channel.isLocked && <Lock className="w-4 h-4 text-text-muted shrink-0" />}
                  <h3 className="text-lg font-bold flex-1">{channel.name}</h3>
                  {currentUserId && channel.ownerId === currentUserId && (
                    <button
                      onClick={(e) => handleDeleteChannel(e, channel.id)}
                      className="text-text-dim hover:text-danger text-sm px-1"
                      title={t("channels.deleteChannel")}
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>
                {channel.description && (
                  <p className="text-text-muted text-sm mb-3 line-clamp-2">
                    {channel.description}
                  </p>
                )}
                <div className="flex flex-wrap gap-2 mb-3">
                  <span className="rounded-full bg-surface-raised px-2 py-1 text-[11px] font-medium text-text-muted">
                    {channel.isPublic ? t("channels.public") : t("channels.private")}
                  </span>
                  {channel.groupName && (
                    <span className="rounded-full bg-surface-raised px-2 py-1 text-[11px] font-medium text-text-muted">
                      {t("channels.group")}: {channel.groupName}
                    </span>
                  )}
                  {channel.canJoin === false && channel.requiresGroupMembership && (
                    <span className="rounded-full bg-primary-muted px-2 py-1 text-[11px] font-medium text-primary-light">
                      {t("channels.browseOnly")}
                    </span>
                  )}
                </div>
                {channel.canJoin === false && channel.requiresGroupMembership && (
                  <p className="mb-3 text-xs text-text-muted">
                    {t("channels.browseOnlyHint")}
                  </p>
                )}
                <div className="flex items-center justify-between text-xs text-text-dim">
                  <span>{t("channels.owner", { name: channel.ownerNickname || "Unknown" })}</span>
                  <span>
                    {t("channels.players", { count: channel.playerCount, max: channel.maxPlayers })}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Back link */}
        <div className="mt-8">
          <Link
            href="/characters"
            className="text-text-muted hover:text-text text-sm"
          >
            {t("channels.backToCharacters")}
          </Link>
        </div>
      </div>

      {passwordChannel && (
        <PasswordModal
          channelName={passwordChannel.name}
          onSubmit={handlePasswordSubmit}
          onClose={() => setPasswordChannel(null)}
        />
      )}
    </div>
  );
}
