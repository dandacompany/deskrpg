import fs from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import type { KanbanBoard } from "../../src/lib/hermes/deskrpg-plugin-types";

import { OFFICE_LOOKS, officeLookAppearance } from "../../src/game/three/office-looks";
import { deriveChannelMotionLayout } from "../../src/lib/channel-motion-layout";
import { seatingMapFor, type DeskSeat, type SeatingMap } from "../../src/lib/seat-assignment";

export type FixtureApi = {
  request<T>(method: "GET" | "POST" | "PUT" | "PATCH", path: string, body?: unknown): Promise<T>;
};

export const CAPTURE_ACCOUNT = {
  loginId: "readme-capture",
  nickname: "Dante",
  password: "readme-capture-local-only",
} as const;

export type CaptureFixture = {
  loginId: string;
  password: string;
  characterName: string;
  channelId: string;
  reportCardId: string;
  npcNames: ["Sophie", "Noah"];
  profileNames: ["sophie", "noah"];
};

type Identified = { id: string };
type RegistrationResponse = { user: Identified; existing?: boolean };
type CharacterResponse = { character: Identified & { name?: string } };
type CharactersResponse = { characters: Array<Identified & { name?: string }> };
type GatewayResponse = { gateway: Identified };
type GroupsResponse = { groups: Array<Identified & { isDefault?: boolean; slug?: string }> };
type ChannelResponse = { channel: Identified };
type ChannelDetail = { channel: Identified & { mapData?: unknown; mapConfig?: unknown } };
type ChannelsResponse = {
  channels: Array<Identified & { name?: string; ownerId?: string }>;
};
type RosterNpc = Identified & {
  name?: string | null;
  positionX?: number | null;
  positionY?: number | null;
  profile?: { profileName?: string; displayName?: string } | null;
};
type RosterResponse = { npcs: RosterNpc[] };

const PROFILE_REGISTRATIONS = [
  {
    profileName: "sophie",
    token: "readme-capture-sophie-token",
    displayName: "Sophie",
  },
  {
    profileName: "noah",
    token: "readme-capture-noah-token",
    displayName: "Noah",
  },
] as const;

const CHANNEL_NAME = "Dante Labs Office";
/** The capture channel's environment. The server builds the layout from code, so only the ID is passed. */
const CHANNEL_ENVIRONMENT_ID = "trading";
const REPORT_TITLE = "시네마틱 캡처 준비";

function assertLoopbackUrl(rawUrl: string): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Capture gateway URL must be a valid loopback URL");
  }
  const host = url.hostname.toLowerCase();
  const loopback =
    host === "localhost" || host === "::1" || (isIP(host) === 4 && host.startsWith("127."));
  if (!loopback || !["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Capture gateway URL must use a loopback host");
  }
}

function assertCaptureSqlitePath(sqlitePath: string): void {
  const normalized = path.resolve(sqlitePath);
  const marker = `${path.sep}.artifacts${path.sep}readme-capture${path.sep}runtime${path.sep}`;
  if (!normalized.includes(marker)) {
    throw new Error("SQLite path must stay inside the isolated readme-capture runtime");
  }
  const markerIndex = normalized.indexOf(marker);
  let current = normalized.slice(0, markerIndex);
  for (const segment of normalized.slice(markerIndex + path.sep.length).split(path.sep)) {
    current = path.join(current, segment);
    if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error("SQLite path must not traverse symlinks in the readme-capture runtime");
    }
  }
}

function requireId(value: Identified | undefined, label: string): string {
  if (!value || typeof value.id !== "string" || !value.id) {
    throw new Error(`${label} response is missing an ID`);
  }
  return value.id;
}

/** The meeting room entrance tile. Seats are picked close to the meeting room to shorten gathering time. */
function meetingEntryTile(mapData: unknown): { col: number; row: number } | null {
  const layout = deriveChannelMotionLayout(
    { mapData } as Parameters<typeof deriveChannelMotionLayout>[0],
    [],
  );
  const entry = layout?.meetingSpace?.entry;
  return entry ? { col: Math.floor(entry.x), row: Math.floor(entry.y) } : null;
}

/** How far (in tiles) to put Sophie from the spawn. The call scene needs walking, and the meeting must gather within 9 seconds. */
const SOPHIE_DISTANCE = 6;

/**
 * Pick two seats for the scenes and the player spawn.
 *
 * - Seat Noah right next to the spawn — someone must be nearby for the scene to start with the room input open
 *   (conversation range 64px = 2 cells).
 * - Seat Sophie a few cells away — the "호출하기" scene only works if Sophie has to walk over.
 *   Among those, pick a seat close to the meeting room — the meeting scene must gather and finish speaking within 9 seconds.
 */
function captureSeating(
  seating: SeatingMap | null,
  meeting: { col: number; row: number } | null,
): { sophie: DeskSeat; noah: DeskSeat; spawn: { col: number; row: number } } | null {
  if (!seating || seating.seats.length < 2 || seating.standing.length === 0) return null;
  for (const noah of seating.seats) {
    const spawn = seating.standing.find(
      (tile) => Math.abs(tile.col - noah.col) <= 1 && Math.abs(tile.row - noah.row) <= 1,
    );
    if (!spawn) continue;
    // Do not use the farthest seat — walking over in the meeting scene overruns the 9-second clip (measured 17.7s).
    // Only as far as the call scene needs.
    const sophie = seating.seats
      .filter((seat) => seat.number !== noah.number)
      .map((seat) => ({
        seat,
        away: Math.hypot(seat.col - spawn.col, seat.row - spawn.row),
        toMeeting: meeting ? Math.hypot(seat.col - meeting.col, seat.row - meeting.row) : 0,
      }))
      .filter((entry) => entry.away > 3 && entry.away <= SOPHIE_DISTANCE)
      .sort((a, b) => a.toMeeting - b.toMeeting)[0]?.seat;
    if (!sophie) continue;
    return { sophie, noah, spawn };
  }
  return null;
}

function findRosterNpc(npcs: RosterNpc[], profileName: "sophie" | "noah"): RosterNpc {
  const displayName = profileName === "sophie" ? "Sophie" : "Noah";
  const npc = npcs.find(
    (entry) =>
      entry.profile?.profileName === profileName ||
      entry.profile?.displayName === displayName ||
      entry.name === displayName,
  );
  if (!npc) throw new Error(`${displayName} is missing from the channel roster`);
  return npc;
}

export async function prepareFixture(
  api: FixtureApi,
  gatewayBaseUrl: string,
  sqlitePath: string,
): Promise<CaptureFixture> {
  assertLoopbackUrl(gatewayBaseUrl);
  assertCaptureSqlitePath(sqlitePath);

  const registration = await api.request<RegistrationResponse>(
    "POST",
    "/api/auth/register",
    CAPTURE_ACCOUNT,
  );
  const userId = requireId(registration.user, "User");

  let character: Identified & { name?: string };
  if (registration.existing) {
    const existing = await api.request<CharactersResponse>("GET", "/api/characters");
    character =
      existing.characters.find((entry) => entry.name === "Dante") ??
      (
        await api.request<CharacterResponse>("POST", "/api/characters", {
          name: "Dante",
          appearance: officeLookAppearance(OFFICE_LOOKS[0].id),
        })
      ).character;
  } else {
    character = (
      await api.request<CharacterResponse>("POST", "/api/characters", {
        name: "Dante",
        appearance: officeLookAppearance(OFFICE_LOOKS[0].id),
      })
    ).character;
  }
  requireId(character, "Character");

  const gateway = await api.request<GatewayResponse>("POST", "/api/gateways", {
    url: gatewayBaseUrl,
    token: "readme-capture-gateway-token",
    displayName: "README Capture",
  });
  const gatewayId = requireId(gateway.gateway, "Gateway");

  for (const [index, profile] of PROFILE_REGISTRATIONS.entries()) {
    const registered = await api.request<{ profile: Identified }>(
      "POST",
      `/api/gateways/${encodeURIComponent(gatewayId)}/profiles`,
      profile,
    );
    await api.request(
      "PATCH",
      `/api/gateways/${encodeURIComponent(gatewayId)}/profiles/${requireId(registered.profile, "Profile")}`,
      {
        appearance: officeLookAppearance(OFFICE_LOOKS[index + 1].id),
      },
    );
  }

  const groups = await api.request<GroupsResponse>("GET", "/api/groups");
  const group = groups.groups.find((entry) => entry.isDefault || entry.slug === "default");
  const groupId = requireId(group, "Default group");

  let channelId: string;
  if (registration.existing) {
    const existing = await api.request<ChannelsResponse>("GET", "/api/channels");
    const channel = existing.channels.find(
      (entry) => entry.name === CHANNEL_NAME && entry.ownerId === userId,
    );
    channelId = channel
      ? requireId(channel, "Channel")
      : requireId(
          (
            await api.request<ChannelResponse>("POST", "/api/channels", {
              name: CHANNEL_NAME,
              description: "Hermes agents at work",
              isPublic: true,
              environmentId: CHANNEL_ENVIRONMENT_ID,
              groupId,
              gatewayConfig: { gatewayId },
            })
          ).channel,
          "Channel",
        );
  } else {
    const response = await api.request<ChannelResponse>("POST", "/api/channels", {
      name: CHANNEL_NAME,
      description: "Hermes agents at work",
      isPublic: true,
      environmentId: CHANNEL_ENVIRONMENT_ID,
      groupId,
      gatewayConfig: { gatewayId },
    });
    channelId = requireId(response.channel, "Channel");
  }

  const roster = await api.request<RosterResponse>(
    "GET",
    `/api/npcs?channelId=${encodeURIComponent(channelId)}&roster=1`,
  );
  const sophie = findRosterNpc(roster.npcs, "sophie");
  const noah = findRosterNpc(roster.npcs, "noah");
  // The map decides seats — hard-coded coordinates get blocked with `not_a_desk_seat` whenever seat assignment changes.
  const detail = await api.request<ChannelDetail>(
    "GET",
    `/api/channels/${encodeURIComponent(channelId)}`,
  );
  const seating = seatingMapFor({
    mapData: detail.channel.mapData,
    mapConfig: detail.channel.mapConfig,
  });
  const scene = captureSeating(seating, meetingEntryTile(detail.channel.mapData));
  if (scene) {
    // Move the spawn so the player starts within conversation range (2 cells) — the room input is not locked.
    await api.request("PUT", `/api/channels/${encodeURIComponent(channelId)}`, {
      mapConfig: {
        ...(typeof detail.channel.mapConfig === "object" && detail.channel.mapConfig !== null
          ? (detail.channel.mapConfig as Record<string, unknown>)
          : {}),
        spawnCol: scene.spawn.col,
        spawnRow: scene.spawn.row,
      },
    });
    await api.request("PUT", `/api/npcs/${sophie.id}`, {
      positionX: scene.sophie.col,
      positionY: scene.sophie.row,
      direction: "down",
    });
    await api.request("PUT", `/api/npcs/${noah.id}`, {
      positionX: scene.noah.col,
      positionY: scene.noah.row,
      direction: "down",
    });
  }

  // Cards remain in Hermes; DeskRPG creates only the board binding and room notices.
  const boardPath = `/api/channels/${encodeURIComponent(channelId)}/kanban`;
  const board = await api.request<KanbanBoard>("GET", `${boardPath}/board`);
  const existingCard = board.columns
    .flatMap((column) => column.tasks)
    .find((card) => card.title === REPORT_TITLE && card.assignee === "sophie");
  const reportCardId =
    existingCard?.id ??
    requireId(
      (
        await api.request<{ task: Identified }>("POST", `${boardPath}/tasks`, {
          title: REPORT_TITLE,
          body: "장면과 미디어 규격 점검을 완료했습니다.",
          assignee: sophie.id,
        })
      ).task,
      "Hermes card",
    );

  return {
    loginId: CAPTURE_ACCOUNT.loginId,
    password: CAPTURE_ACCOUNT.password,
    characterName: "Dante",
    channelId,
    reportCardId,
    npcNames: ["Sophie", "Noah"],
    profileNames: ["sophie", "noah"],
  };
}
