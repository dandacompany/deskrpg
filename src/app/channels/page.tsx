"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import PasswordModal from "@/components/PasswordModal";
import Modal from "@/components/ui/Modal";
import { useT } from "@/lib/i18n";
import { getLocalizedErrorMessage } from "@/lib/i18n/error-codes";
import { Lock, X } from "lucide-react";
import type { GroupMemberRole } from "@/lib/rbac/constants";
import RosterAvatar from "@/components/RosterAvatar";
import environmentThumbnails from "@/game/three/office-environment-thumbnails.json";

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
  createdAt: string;
  /** The office environment judged from the map — used for the thumbnail. null if unknown. */
  environmentId?: string | null;
  /** Owner + members (people). */
  memberCount?: number;
  /** The first five. appearance is the latest character's appearance. */
  participants?: Array<{ nickname: string | null; appearance: unknown }>;
  canView?: boolean;
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
  canCreateChannel?: boolean;
  canManageGroup?: boolean;
}

export default function ChannelsPage() {
  const t = useT();
  return (
    <Suspense
      fallback={
        <div className="theme-web min-h-screen flex items-center justify-center bg-bg text-text">
          {t("common.loading")}
        </div>
      }
    >
      <ChannelsPageInner />
    </Suspense>
  );
}

function ChannelsPageInner() {
  const router = useRouter();
  const t = useT();

  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [joinCode, setJoinCode] = useState("");
  const [joinDialog, setJoinDialog] = useState<"channel" | "group" | null>(null);
  const [joinError, setJoinError] = useState("");
  const [groupInviteCode, setGroupInviteCode] = useState("");
  const [groupInviteError, setGroupInviteError] = useState("");
  const [groupInviteSuccess, setGroupInviteSuccess] = useState("");
  const [passwordChannel, setPasswordChannel] = useState<Channel | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [availableGroups, setAvailableGroups] = useState<GroupOption[]>([]);
  // The server decides the "me" entering the office. Here we only check existence — if none, draw the guide card.
  const [hasCharacter, setHasCharacter] = useState(true);

  const fetchLobbyData = async () => {
    const [channelResponse, groupResponse] = await Promise.all([
      fetch("/api/channels"),
      fetch("/api/groups")
        .then((res) => (res.ok ? res.json() : { groups: [] }))
        .catch(() => ({ groups: [] })),
    ]);
    const channelData = await channelResponse.json();
    return {
      channels: channelData.channels || [],
      currentUserId: channelData.currentUserId || null,
      availableGroups: groupResponse.groups || [],
    };
  };

  useEffect(() => {
    void (async () => {
      try {
        const [data, mine] = await Promise.all([
          fetchLobbyData(),
          fetch("/api/characters/me")
            .then((res) => (res.ok ? res.json() : null))
            .catch(() => null),
        ]);
        setChannels(data.channels);
        setCurrentUserId(data.currentUserId);
        setAvailableGroups(data.availableGroups);
        // If the read itself fails, do not block the list — on entry the server blocks again with character_missing.
        setHasCharacter(mine ? mine.character !== null : true);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

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
          getLocalizedErrorMessage(t, { errorCode: channel.joinAccessReason }, "errors.forbidden"),
        );
      }
      return;
    }

    if ((channel.requiresPassword ?? channel.isLocked) && !channel.isMember) {
      setPasswordChannel(channel);
    } else {
      router.push(`/game?channelId=${channel.id}`);
    }
  };

  const handlePasswordSubmit = async (password: string): Promise<string | null> => {
    if (!passwordChannel) return t("password.wrong");
    try {
      const res = await fetch(`/api/channels/${passwordChannel.id}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        return getLocalizedErrorMessage(t, data, "password.wrong");
      }
      router.push(`/game?channelId=${passwordChannel.id}`);
      return null;
    } catch {
      return t("channels.joinFailed");
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

      router.push(`/game?channelId=${data.channel.id}`);
    } catch {
      setJoinError(t("channels.joinFailed"));
    }
  };

  const handleGroupInviteAccept = async () => {
    if (!groupInviteCode.trim()) return;
    setGroupInviteError("");
    setGroupInviteSuccess("");

    try {
      const res = await fetch(`/api/groups/invites/${groupInviteCode.trim()}`, {
        method: "POST",
      });
      const inviteData = await res.json().catch(() => ({}));
      if (!res.ok) {
        setGroupInviteError(getLocalizedErrorMessage(t, inviteData, "channels.invalidInvite"));
        return;
      }

      const lobbyData = await fetchLobbyData();
      setChannels(lobbyData.channels);
      setCurrentUserId(lobbyData.currentUserId);
      setAvailableGroups(lobbyData.availableGroups);
      setGroupInviteSuccess(
        t("channels.groupInviteAccepted", {
          name: inviteData?.group?.name || t("channels.group"),
        }),
      );
      setGroupInviteCode("");
    } catch {
      setGroupInviteError(t("channels.groupInviteFailed"));
    }
  };

  const closeJoinDialog = () => setJoinDialog(null);
  const canCreateChannels = availableGroups.some((group) => group.canCreateChannel);
  const canManageGroups = availableGroups.some((group) => group.canManageGroup);

  if (loading) {
    return (
      <div className="theme-web min-h-screen flex items-center justify-center bg-bg text-text">
        {t("channels.loadingChannels")}
      </div>
    );
  }

  return (
    <div className="theme-web workspace-page">
      <div className="workspace-page-inner">
        {/* Header */}
        <div className="mb-8 flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <div>
            <h1 className="text-3xl font-bold">{t("channels.title")}</h1>
            <p className="text-text-muted mt-1">{t("channels.subtitle")}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setJoinDialog("channel")}
              className="whitespace-nowrap rounded bg-surface-raised px-4 py-2 font-semibold hover:bg-surface-raised/80"
            >
              {t("channels.joinByCode")}
            </button>
            <button
              type="button"
              onClick={() => setJoinDialog("group")}
              className="whitespace-nowrap rounded bg-surface-raised px-4 py-2 font-semibold hover:bg-surface-raised/80"
            >
              {t("channels.groupInviteJoin")}
            </button>
            {canManageGroups && (
              <Link
                href="/admin/groups"
                className="whitespace-nowrap rounded bg-surface-raised px-4 py-2 font-semibold hover:bg-surface-raised/80"
              >
                {t("channels.manageGroups")}
              </Link>
            )}
            {canCreateChannels ? (
              <Link
                href="/channels/create"
                className="whitespace-nowrap rounded bg-primary px-4 py-2 font-semibold text-white hover:bg-primary-hover"
              >
                {t("channels.createChannel")}
              </Link>
            ) : (
              <button
                type="button"
                disabled
                className="cursor-not-allowed whitespace-nowrap rounded bg-surface-raised px-4 py-2 font-semibold text-text-dim opacity-60"
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

        {/* Join code and group join are top button → popup (Dante's decision, 2026-09-20) — keep the space above the list empty. */}
        {joinDialog && (
          <Modal
            open
            onClose={closeJoinDialog}
            title={
              joinDialog === "channel" ? t("channels.joinByCode") : t("channels.groupInviteTitle")
            }
            size="sm"
          >
            {joinDialog === "channel" ? (
              <div className="space-y-3">
                <input
                  type="text"
                  autoFocus
                  placeholder={t("channels.inviteCodePlaceholder")}
                  value={joinCode}
                  onChange={(e) => setJoinCode(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleJoinByCode()}
                  className="w-full rounded border border-border bg-surface px-3 py-2 text-text placeholder-text-dim focus:outline-none focus:ring-2 focus:ring-primary-light"
                />
                {joinError && <p className="text-sm text-danger">{joinError}</p>}
                <button
                  onClick={handleJoinByCode}
                  className="rounded bg-primary px-4 py-2 font-semibold text-white hover:bg-primary-hover"
                >
                  {t("common.join")}
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-text-muted">{t("channels.groupInviteSubtitle")}</p>
                <input
                  type="text"
                  autoFocus
                  placeholder={t("channels.groupInvitePlaceholder")}
                  value={groupInviteCode}
                  onChange={(e) => setGroupInviteCode(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleGroupInviteAccept()}
                  className="w-full rounded border border-border bg-surface px-3 py-2 text-text placeholder-text-dim focus:outline-none focus:ring-2 focus:ring-primary-light"
                />
                {groupInviteError && <p className="text-sm text-danger">{groupInviteError}</p>}
                {groupInviteSuccess && (
                  <p className="text-sm text-primary-light">{groupInviteSuccess}</p>
                )}
                <button
                  onClick={handleGroupInviteAccept}
                  className="rounded bg-primary px-4 py-2 font-semibold text-white hover:bg-primary-hover"
                >
                  {t("channels.groupInviteJoin")}
                </button>
              </div>
            )}
          </Modal>
        )}

        {/* Channel grid */}
        {!hasCharacter ? (
          <div className="rounded-2xl border border-border bg-surface px-6 py-14 text-center">
            <h2 className="text-lg font-semibold">{t("channels.needCharacterTitle")}</h2>
            <p className="mx-auto mt-2 max-w-lg text-sm text-text-muted">
              {t("channels.needCharacterBody")}
            </p>
            <Link
              href="/characters"
              className="mt-6 inline-flex rounded-xl bg-primary px-5 py-3 text-sm font-semibold text-white"
            >
              {t("channels.needCharacterAction")}
            </Link>
          </div>
        ) : channels.length === 0 ? (
          <div className="text-center py-20">
            <p className="text-text-muted mb-4">{t("channels.noChannels")}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {channels.map((channel) => (
              <div
                key={channel.id}
                data-channel-id={channel.id}
                onClick={() => handleChannelClick(channel)}
                className={`flex h-full flex-col bg-surface p-5 rounded-lg transition-all ${
                  channel.canJoin === false
                    ? "cursor-default ring-1 ring-border"
                    : "cursor-pointer hover:ring-2 hover:ring-primary"
                }`}
              >
                <ChannelThumbnail
                  environmentId={channel.environmentId ?? null}
                  name={channel.name}
                />
                <div className="flex items-center gap-2 mb-1">
                  {channel.isLocked && <Lock className="w-4 h-4 text-text-muted shrink-0" />}
                  <h3 className="line-clamp-1 flex-1 text-lg font-bold" title={channel.name}>
                    {channel.name}
                  </h3>
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
                {/* Always take two lines of space so the row below does not shift when the description is missing or long. */}
                <p
                  className="mb-3 line-clamp-2 min-h-[2.5rem] text-sm text-text-muted"
                  title={channel.description ?? undefined}
                >
                  {channel.description}
                </p>
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
                  <p className="mb-3 text-xs text-text-muted">{t("channels.browseOnlyHint")}</p>
                )}
                <div className="mt-auto flex items-center justify-between gap-2 text-xs text-text-dim">
                  <span className="truncate">
                    {t("channels.owner", { name: channel.ownerNickname || t("common.unknown") })}
                  </span>
                  <ParticipantStack
                    participants={channel.participants ?? []}
                    count={channel.memberCount ?? 0}
                    label={t("channels.memberCount", { count: channel.memberCount ?? 0 })}
                  />
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Back link */}
        <div className="mt-8">
          <Link href="/characters" className="text-text-muted hover:text-text text-sm">
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

const THUMBNAILS = environmentThumbnails as Record<string, string>;

/** The same pre-rendered thumbnail and aspect ratio as new channel creation (`OfficeEnvironmentPicker`). */
function ChannelThumbnail({ environmentId, name }: { environmentId: string | null; name: string }) {
  const src = environmentId ? THUMBNAILS[environmentId] : undefined;
  return (
    <div className="-mx-5 -mt-5 mb-4 aspect-[874/450] overflow-hidden rounded-t-lg bg-background">
      {src ? (
        <Image
          data-channel-thumbnail=""
          src={src}
          width={874}
          height={450}
          sizes="(max-width: 768px) 100vw, (max-width: 1024px) 50vw, 300px"
          alt={name}
          className="h-full w-full object-contain"
        />
      ) : (
        <div data-channel-thumbnail-placeholder="" className="h-full w-full" aria-hidden />
      )}
    </div>
  );
}

const AVATAR_SIZE = 24;

/** Overlap participant round avatars (up to five), +N when they overflow, and "N명 참여" beside them. */
function ParticipantStack({
  participants,
  count,
  label,
}: {
  participants: Array<{ nickname: string | null; appearance: unknown }>;
  count: number;
  label: string;
}) {
  const rest = Math.max(0, count - participants.length);
  return (
    <span className="flex shrink-0 items-center gap-2">
      <span className="flex -space-x-2">
        {participants.map((participant, index) => (
          <span
            key={index}
            data-participant-avatar=""
            title={participant.nickname ?? undefined}
            className="rounded-full ring-2 ring-surface"
          >
            <RosterAvatar appearance={participant.appearance} size={AVATAR_SIZE} />
          </span>
        ))}
        {rest > 0 && (
          <span
            className="flex items-center justify-center rounded-full bg-surface-raised text-[10px] font-medium text-text-muted ring-2 ring-surface"
            style={{ width: AVATAR_SIZE, height: AVATAR_SIZE }}
          >
            +{rest}
          </span>
        )}
      </span>
      <span>{label}</span>
    </span>
  );
}
