import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

/**
 * Seed helpers shared by NPC-related route/server tests.
 *
 * Since `npcs.hermes_profile_id` became NOT NULL, the schema rejects seeds that insert "NPCs without a profile".
 * Instead of each test copying the users → gateway → profile → channel → npc chain
 * separately, it lives in one place here. Functions are split one per concern,
 * so pick and assemble only the pieces needed.
 *
 * `db` is a lazily initialized module singleton, so to use a temporary SQLite the environment variables must be set
 * **before** `@/db` is first loaded. That is why every helper in this file
 * imports `@/db` dynamically — a test file only needs to call `setupThrowawaySqlite()`
 * at the top of the module.
 */

/** Grab a SQLite file just for this test process and delete it on exit. */
export function setupThrowawaySqlite(label: string): string {
  const sqlitePath = path.join(os.tmpdir(), `${label}-${crypto.randomUUID()}.db`);
  // If DATABASE_URL is in the environment, @/db sees it and connects to Postgres (src/db/index.ts:22).
  // State the intent to use a temporary SQLite explicitly — so running it as is in a developer's shell gives the same result.
  process.env.DB_TYPE = "sqlite";
  process.env.DESKRPG_HOME = os.tmpdir();
  process.env.SQLITE_PATH = sqlitePath;
  for (const ext of ["", "-wal", "-shm"]) {
    process.on("exit", () => fs.rmSync(`${sqlitePath}${ext}`, { force: true }));
  }
  return sqlitePath;
}

async function loadDb() {
  return import("@/db");
}

/**
 * The minimal stub that `probeHermesGateway` judges as "hermes".
 * `/health` must be 2xx and `/v1/models` must have a JSON content-type (gateway-probe.ts).
 */
export async function startStubHermesGateway(): Promise<{ baseUrl: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    if (req.url === "/health" || req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", data: [] }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to bind stub gateway");
  // Keep the test runner from hanging on this handle.
  server.unref();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => server.close(),
  };
}

let sharedStub: { baseUrl: string; close: () => void } | null = null;
async function sharedStubBaseUrl() {
  if (!sharedStub) sharedStub = await startStubHermesGateway();
  return sharedStub.baseUrl;
}

export async function seedUser(prefix = "user") {
  const { db, users } = await loadDb();
  const suffix = crypto.randomUUID().slice(0, 8);
  const [user] = await db
    .insert(users)
    .values({
      loginId: `${prefix}-${suffix}`,
      nickname: `${prefix}-${suffix}`,
      passwordHash: "hash",
    })
    .returning();
  return user;
}

export async function seedGateway(ownerUserId: string, baseUrl = "http://gw.test") {
  const { db, gatewayResources } = await loadDb();
  const { encryptGatewayToken } = await import("@/lib/gateway-resources");
  const [gateway] = await db
    .insert(gatewayResources)
    .values({
      ownerUserId,
      displayName: "Test Gateway",
      baseUrl,
      tokenEncrypted: encryptGatewayToken("gateway-owner-key-1234567890"),
    })
    .returning();
  return gateway;
}

export async function seedHermesProfile(
  gatewayId: string,
  opts: { profileName?: string; displayName?: string | null; appearance?: unknown } = {},
) {
  const { db, hermesProfiles, jsonForDb } = await loadDb();
  const { encryptGatewayToken } = await import("@/lib/gateway-resources");
  const [profile] = await db
    .insert(hermesProfiles)
    .values({
      gatewayId,
      profileName: opts.profileName ?? `profile-${crypto.randomUUID().slice(0, 8)}`,
      tokenEncrypted: encryptGatewayToken("profile-key-1234567890"),
      displayName: opts.displayName ?? null,
      appearance: jsonForDb(opts.appearance ?? { bodyType: "female", layers: {} }),
    })
    .returning();
  return profile;
}

export async function seedChannel(ownerId: string, name = "Test Channel", mapData?: unknown) {
  const { db, channels, jsonForDb } = await loadDb();
  const [channel] = await db
    .insert(channels)
    .values(
      mapData !== undefined ? { name, ownerId, mapData: jsonForDb(mapData) } : { name, ownerId },
    )
    .returning();
  return channel;
}

export async function seedNpc(input: {
  channelId: string;
  hermesProfileId: string;
  name?: string | null;
  positionX?: number | null;
  positionY?: number | null;
  active?: boolean;
  adapterType?: string;
  appearance?: unknown;
  agentConfig?: unknown;
}) {
  const { db, npcs, jsonForDb } = await loadDb();
  const [npc] = await db
    .insert(npcs)
    .values({
      channelId: input.channelId,
      hermesProfileId: input.hermesProfileId,
      name: input.name ?? "Test NPC",
      positionX: input.positionX ?? null,
      positionY: input.positionY ?? null,
      active: input.active ?? true,
      adapterType: input.adapterType ?? "hermes",
      appearance: jsonForDb(input.appearance ?? {}),
      agentConfig: jsonForDb(input.agentConfig ?? {}),
    })
    .returning();
  return npc;
}

/**
 * One channel + a gateway binding + NPCs of the requested combination.
 *
 * - `placedActive`: has a seat and is clocked in — the only kind that must appear in the default `/api/npcs` response
 * - `unplaced`: only the profile is hired and there is no seat yet (`position_x/y` NULL)
 * - `dormant`: remembers the seat but has clocked out (`active = 0`)
 */
export async function seedChannelWithProfiles(opts: {
  placedActive?: number;
  unplaced?: number;
  dormant?: number;
  /** Number of profiles only registered on the gateway without creating NPC rows — the "before hiring" state. */
  profiles?: number;
  /** An old value to leave in `npcs.name` — it must not leak into responses. */
  staleNpcName?: string;
  /** The first profile's display name — the response's `name` must be this. */
  displayName?: string;
  /** The channel's map data — if present, seat assignment tests can compute real seats. */
  mapData?: unknown;
}) {
  const { placedActive = 0, unplaced = 0, dormant = 0, profiles = 0 } = opts;

  const user = await seedUser("channel-owner");
  const gateway = await seedGateway(user.id, await sharedStubBaseUrl());
  const channel = await seedChannel(user.id, undefined, opts.mapData);

  const { bindGatewayToChannel } = await import("@/lib/gateway-resources");
  await bindGatewayToChannel({
    channelId: channel.id,
    gatewayId: gateway.id,
    boundByUserId: user.id,
  });

  const profileIds: string[] = [];
  const npcIds: string[] = [];
  // Seats must be unique within a channel (npcs_channel_position_unique). Shift each placed NPC
  // one cell over.
  let nextColumn = 0;
  let isFirst = true;

  async function add(kind: "placedActive" | "unplaced" | "dormant") {
    const profile = await seedHermesProfile(gateway.id, {
      displayName: isFirst ? (opts.displayName ?? null) : null,
    });
    profileIds.push(profile.id);
    const placed = kind !== "unplaced";
    const npc = await seedNpc({
      channelId: channel.id,
      hermesProfileId: profile.id,
      name: isFirst ? (opts.staleNpcName ?? "Test NPC") : "Test NPC",
      positionX: placed ? nextColumn++ : null,
      positionY: placed ? 0 : null,
      active: kind !== "dormant",
    });
    npcIds.push(npc.id);
    isFirst = false;
  }

  for (let i = 0; i < placedActive; i += 1) await add("placedActive");
  for (let i = 0; i < unplaced; i += 1) await add("unplaced");
  for (let i = 0; i < dormant; i += 1) await add("dormant");
  for (let i = 0; i < profiles; i += 1) {
    const profile = await seedHermesProfile(gateway.id, {
      displayName: isFirst ? (opts.displayName ?? null) : null,
    });
    profileIds.push(profile.id);
    isFirst = false;
  }

  return {
    channelId: channel.id,
    gatewayId: gateway.id,
    profileIds,
    npcIds,
    userId: user.id,
  };
}

/** Bind one gateway to several new channels — for seeding `hireProfileIntoBoundChannels`. */
export async function seedGatewayBoundToChannels(opts: { channels: number }) {
  const user = await seedUser("gateway-owner");
  const gateway = await seedGateway(user.id, await sharedStubBaseUrl());

  const { bindGatewayToChannel } = await import("@/lib/gateway-resources");
  const channelIds: string[] = [];
  for (let i = 0; i < opts.channels; i += 1) {
    const channel = await seedChannel(user.id);
    await bindGatewayToChannel({
      channelId: channel.id,
      gatewayId: gateway.id,
      boundByUserId: user.id,
    });
    channelIds.push(channel.id);
  }

  return { gatewayId: gateway.id, channelIds, userId: user.id };
}

/** Only register one profile on the gateway (no NPC row). */
export async function seedProfile(gatewayId: string) {
  const profile = await seedHermesProfile(gatewayId);
  return profile.id;
}

/** Auth headers to pass to route handlers — `getUserId` looks only at `x-user-id`. */
export function authHeaders(userId: string): Record<string, string> {
  return { "x-user-id": userId, "Content-Type": "application/json" };
}

/**
 * One channel + two gateways. Neither is bound to the channel yet — binding is done
 * by the test itself with `PUT /api/channels/:id/gateway` (that is what is being verified).
 */
export async function seedTwoGateways(opts: { profilesEach: number }) {
  const user = await seedUser("two-gateways-owner");
  const baseUrl = await sharedStubBaseUrl();
  const gatewayA = await seedGateway(user.id, baseUrl);
  const gatewayB = await seedGateway(user.id, baseUrl);
  for (const gateway of [gatewayA, gatewayB]) {
    for (let i = 0; i < opts.profilesEach; i += 1) await seedHermesProfile(gateway.id);
  }
  const channel = await seedChannel(user.id);
  return {
    userId: user.id,
    channelId: channel.id,
    gatewayA: gatewayA.id,
    gatewayB: gatewayB.id,
  };
}

/** One set of minutes in the channel. It must survive switching gateways. */
export async function seedMeetingMinutes(channelId: string, topic = "주간 회의") {
  const { db, meetingMinutes } = await loadDb();
  const [row] = await db
    .insert(meetingMinutes)
    .values({ channelId, topic, transcript: "..." })
    .returning();
  return row;
}

export async function countMeetingMinutes(channelId: string): Promise<number> {
  const { db, meetingMinutes } = await loadDb();
  const { eq } = await import("drizzle-orm");
  const rows = await db
    .select({ id: meetingMinutes.id })
    .from(meetingMinutes)
    .where(eq(meetingMinutes.channelId, channelId));
  return rows.length;
}
