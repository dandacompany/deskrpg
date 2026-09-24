import { NextRequest } from "next/server";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { Server } from "socket.io";
import { io as connect, type Socket } from "socket.io-client";
import { SignJWT } from "jose";
import { eq } from "drizzle-orm";
import {
  setupThrowawaySqlite,
  seedUser,
  seedChannel,
  seedGateway,
  seedHermesProfile,
  seedNpc,
  authHeaders,
} from "../test-setup/npc-seed";
import oldMap from "../lib/fixtures/official-agency-v2.json";
import { buildOfficeEnvironment } from "../game/three/office-environments";
import { deriveChannelMotionLayout } from "./channel-motion-layout";
setupThrowawaySqlite("task7-real-socket");
// Even under fully parallel test runs, wait for the real geometry projection and auth completion.
const socketDeadlineMs = 10_000;
const event = <T>(client: Socket, name: string) =>
  new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      client.off(name, listener);
      reject(Error("Timed out: " + name));
    }, socketDeadlineMs);
    const listener = (data: T) => {
      clearTimeout(timeout);
      resolve(data);
    };
    client.once(name, listener);
  });
const joinResult = (client: Socket, payload: unknown) =>
  new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(Error("join timeout: " + JSON.stringify(payload)));
    }, socketDeadlineMs);
    const listener = (name: string) => {
      if (["player:spawn", "map:refresh", "join-error"].includes(name)) {
        cleanup();
        resolve(name);
      }
    };
    const cleanup = () => {
      clearTimeout(timeout);
      client.offAny(listener);
    };
    client.onAny(listener);
    client.emit("player:join", payload);
  });

test("real socket admission rejects absent/empty/stale map revisions after upgrade and reconnect; reactivation uses repaired homes; metadata rename preserves map authority", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { db, channels, characters, jsonForDb, npcs, channelMembers } = await import("../db");
  const { setupSocketHandlers } = await import("./socket-handlers");
  const { DEV_JWT_SECRET } = await import("../lib/dev-constants");
  const user = await seedUser();
  // player:join only admits with my character as decided by the server — no character means character_missing.
  await db.insert(characters).values({ userId: user.id, name: "Test", appearance: jsonForDb({}) });
  const channel = await seedChannel(user.id);
  const gateway = await seedGateway(user.id);
  const profile = await seedHermesProfile(gateway.id);
  const npc = await seedNpc({
    channelId: channel.id,
    hermesProfileId: profile.id,
    positionX: 2,
    positionY: 2,
  });
  await db
    .update(channels)
    .set({ mapData: jsonForDb(oldMap), updatedAt: "v2-revision" as unknown as Date })
    .where(eq(channels.id, channel.id));
  const http = createServer();
  const io = new Server(http, { transports: ["websocket"] });
  const { refreshChannelMap } = setupSocketHandlers(io);
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const address = http.address();
  assert.ok(address && typeof address !== "string");
  const token = await new SignJWT({ userId: user.id, nickname: "test" })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(process.env.JWT_SECRET || DEV_JWT_SECRET));
  const clients: Socket[] = [];
  const open = async (sessionToken = token) => {
    const client = connect(`http://127.0.0.1:${address.port}`, {
      extraHeaders: { cookie: `token=${sessionToken}` },
      transports: ["websocket"],
      forceNew: true,
    });
    clients.push(client);
    await event<void>(client, "connect");
    const deadline = Date.now() + socketDeadlineMs;
    while (!io.sockets.sockets.get(client.id!)?.listenerCount("player:join")) {
      assert.ok(Date.now() < deadline, "authenticated socket handlers must be installed");
      await new Promise((r) => setTimeout(r, 10));
    }
    return client;
  };
  const join = {
    mapId: channel.id,
    x: 496,
    y: 624,
  };
  try {
    const legacy = await open();
    const oldLayout = deriveChannelMotionLayout({ mapData: oldMap }, [])!;
    const entry = oldLayout.meetingSpace!.entry;
    await db.insert(channelMembers).values({
      channelId: channel.id,
      userId: user.id,
      lastX: entry.x * 32,
      lastY: entry.y * 32,
    });
    assert.equal(
      await joinResult(legacy, { ...join, x: entry.x * 32, y: entry.y * 32 }),
      "player:spawn",
    );
    const admitted = event<{ spatial: { participants: unknown[] } }>(legacy, "meeting:state");
    legacy.emit("meeting:join", { channelId: channel.id });
    assert.ok((await admitted).spatial.participants.length);
    assert.ok(io.sockets.adapter.rooms.get(`meeting-${channel.id}`)?.has(legacy.id!));
    const lease = await refreshChannelMap("begin", channel.id);
    await db
      .update(channels)
      .set({
        mapData: jsonForDb(buildOfficeEnvironment("agency")),
        updatedAt: "v3-revision" as unknown as Date,
      })
      .where(eq(channels.id, channel.id));
    await refreshChannelMap("finish", channel.id, lease!);
    assert.equal(
      io.sockets.adapter.rooms.get(`meeting-${channel.id}`)?.has(legacy.id!) ?? false,
      false,
    );
    await new Promise((r) => setTimeout(r, 10));
    assert.notEqual(
      await joinResult(legacy, join),
      "player:spawn",
      "cached existing client without revision must lose authority",
    );
    legacy.close();
    for (const revision of [undefined, "", "v2-revision"]) {
      const client = await open();
      assert.notEqual(
        await joinResult(client, { ...join, mapRevision: revision }),
        "player:spawn",
        String(revision),
      );
      client.close();
    }
    const { GET, PUT } = await import("../app/api/channels/[id]/route");
    const bootstrap = await GET(
      new NextRequest(`http://localhost/api/channels/${channel.id}`, {
        headers: authHeaders(user.id),
      }),
      { params: Promise.resolve({ id: channel.id }) },
    );
    assert.equal(bootstrap.status, 200);
    const currentRevision = (await bootstrap.json()).channel.mapRevision;
    assert.match(currentRevision, /^map-sha256:[a-f0-9]{64}$/);
    const client = await open();
    assert.equal(
      await joinResult(client, { ...join, mapRevision: currentRevision }),
      "player:spawn",
    );
    const off = event<{ npc: { active: boolean } }>(client, "npc:updated");
    client.emit("npc:set-active", { channelId: channel.id, npcId: npc.id, active: false });
    assert.equal((await off).npc.active, false);
    const on = event<{ npc: { active: boolean; positionX: number; positionY: number } }>(
      client,
      "npc:updated",
    );
    const motion = event<{
      npcs: Array<{ npcId: string; homeX: number; homeY: number; x: number; y: number }>;
    }>(client, "npc:motion-state");
    client.emit("npc:set-active", { channelId: channel.id, npcId: npc.id, active: true });
    const updated = (await on).npc;
    const state = (await motion).npcs.find((n) => n.npcId === npc.id)!;
    assert.deepEqual(
      [updated.positionX, updated.positionY],
      [state.homeX / 32 - 0.5, state.homeY / 32 - 0.5],
    );
    assert.notDeepEqual([updated.positionX, updated.positionY], [2, 2]);
    const call = await client
      .timeout(2000)
      .emitWithAck("npc:call", { channelId: channel.id, npcId: npc.id });
    assert.equal(call.ok, true);
    const returning = await client
      .timeout(2000)
      .emitWithAck("npc:return-home", { channelId: channel.id, npcId: npc.id });
    assert.equal(returning.ok, true);
    const returned = event<{
      npcs: Array<{ npcId: string; homeX: number; homeY: number; phase: string }>;
    }>(client, "npc:motion-state");
    await client.timeout(2000).emitWithAck("npc:position-update", {
      channelId: channel.id,
      npcId: npc.id,
      x: state.homeX,
      y: state.homeY,
      direction: "down",
    });
    const arrived = event<{ npcs: Array<{ npcId: string; phase: string; homeX: number }> }>(
      client,
      "npc:motion-state",
    );
    await client.timeout(2000).emitWithAck("npc:arrived", { channelId: channel.id, npcId: npc.id });
    const settled = (await arrived).npcs.find((n) => n.npcId === npc.id)!;
    assert.equal(settled.phase, "idle");
    assert.equal(settled.homeX, state.homeX);
    assert.ok((await returned).npcs.some((n) => n.npcId === npc.id && n.homeX === state.homeX));
    const viewer = await seedUser();
    await db.insert(channelMembers).values({ channelId: channel.id, userId: viewer.id });
    await db
      .insert(characters)
      .values({ userId: viewer.id, name: "Viewer", appearance: jsonForDb({}) });
    const viewerToken = await new SignJWT({ userId: viewer.id, nickname: "Viewer" })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(process.env.JWT_SECRET || DEV_JWT_SECRET));
    const observer = await open(viewerToken);
    assert.equal(
      await joinResult(observer, {
        ...join,
        mapRevision: currentRevision,
      }),
      "player:spawn",
    );
    const broadcast = event<{ npc: { positionX: number; positionY: number } }>(
      observer,
      "npc:updated",
    );
    client.emit("npc:broadcast-update", { npc: { id: npc.id, positionX: 2, positionY: 2 } });
    const rebroadcast = (await broadcast).npc;
    assert.deepEqual(
      [rebroadcast.positionX, rebroadcast.positionY],
      [state.homeX / 32 - 0.5, state.homeY / 32 - 0.5],
    );
    const rename = await PUT(
      new NextRequest(`http://localhost/api/channels/${channel.id}`, {
        method: "PUT",
        headers: authHeaders(user.id),
        body: JSON.stringify({ name: "Renamed studio" }),
      }),
      { params: Promise.resolve({ id: channel.id }) },
    );
    assert.equal(rename.status, 200);
    const renamedBootstrap = await GET(
      new NextRequest(`http://localhost/api/channels/${channel.id}`, {
        headers: authHeaders(user.id),
      }),
      { params: Promise.resolve({ id: channel.id }) },
    );
    const renamedChannel = (await renamedBootstrap.json()).channel;
    assert.equal(renamedChannel.mapRevision, currentRevision);
    assert.equal(renamedChannel.rowRevision, undefined, "row CAS token is internal");
    const afterRename = event<{ npc: { positionX: number; positionY: number } }>(
      observer,
      "npc:updated",
    );
    client.emit("npc:broadcast-update", { npcId: npc.id });
    assert.deepEqual(
      (await afterRename).npc,
      rebroadcast,
      "metadata changes must preserve admitted map authority",
    );

    // A real map edit still changes admission, even without the migration lease.
    const edited = buildOfficeEnvironment("tech");
    const replace = await PUT(
      new NextRequest(`http://localhost/api/channels/${channel.id}`, {
        method: "PUT",
        headers: authHeaders(user.id),
        body: JSON.stringify({ mapData: edited }),
      }),
      { params: Promise.resolve({ id: channel.id }) },
    );
    assert.equal(replace.status, 200);
    const staleUpdates: unknown[] = [];
    observer.on("npc:updated", (data) => staleUpdates.push(data));
    client.emit("npc:broadcast-update", { npcId: npc.id });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepEqual(
      staleUpdates,
      [],
      "actual map replacement must reject the old admitted revision",
    );
    assert.equal(
      await joinResult(client, { ...join, mapRevision: currentRevision }),
      "map:refresh",
    );
    const [persisted] = await db.select().from(npcs).where(eq(npcs.id, npc.id));
    assert.deepEqual([persisted.positionX, persisted.positionY], [2, 2]);
  } finally {
    clients.forEach((c) => c.close());
    await new Promise<void>((r) => io.close(() => r()));
    if (http.listening) await new Promise<void>((r) => http.close(() => r()));
  }
});
