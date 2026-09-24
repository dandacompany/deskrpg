import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildOfficeEnvironment } from "../../src/game/three/office-environments";
import { seatingMapFor } from "../../src/lib/seat-assignment";

import { CAPTURE_ACCOUNT, prepareFixture, type FixtureApi } from "./fixture";

// The map the capture channel actually uses. If seats change, this test moves with them.
const captureMap = buildOfficeEnvironment("trading");
const captureSeats = seatingMapFor({ mapData: captureMap })!;

function recordingFixtureApi(calls: string[]): FixtureApi {
  return {
    async request<T>(
      method: "GET" | "POST" | "PUT" | "PATCH",
      requestPath: string,
      body?: unknown,
    ) {
      if (method === "POST" && requestPath === "/api/auth/register") {
        calls.push("register");
        assert.deepEqual(body, CAPTURE_ACCOUNT);
        return { user: { id: "user-1", nickname: "Dante" } } as T;
      }
      if (method === "POST" && requestPath === "/api/characters") {
        calls.push("character");
        assert.equal((body as { name?: string }).name, "Dante");
        assert.ok((body as { appearance?: unknown }).appearance);
        return { character: { id: "character-1", name: "Dante" } } as T;
      }
      if (method === "POST" && requestPath === "/api/gateways") {
        calls.push("gateway");
        assert.deepEqual(body, {
          url: "http://127.0.0.1:38642",
          token: "readme-capture-gateway-token",
          displayName: "README Capture",
        });
        return { gateway: { id: "gateway-1" } } as T;
      }
      if (method === "POST" && requestPath === "/api/gateways/gateway-1/profiles") {
        const profileName = (body as { profileName: string }).profileName;
        calls.push(`profile:${profileName}`);
        const displayName = profileName === "sophie" ? "Sophie" : "Noah";
        assert.deepEqual(body, {
          profileName,
          token: `readme-capture-${profileName}-token`,
          displayName,
        });
        return { profile: { id: `profile-${profileName}`, profileName, displayName } } as T;
      }
      if (method === "GET" && requestPath === "/api/groups") {
        calls.push("group");
        return { groups: [{ id: "group-1", name: "Default", isDefault: true }] } as T;
      }
      if (
        method === "PATCH" &&
        requestPath.startsWith("/api/gateways/gateway-1/profiles/profile-")
      ) {
        assert.ok((body as { appearance?: unknown }).appearance);
        return { ok: true } as T;
      }
      if (method === "PUT" && requestPath.startsWith("/api/npcs/npc-")) {
        const sophie = requestPath.endsWith("sophie");
        const seat = body as { positionX: number; positionY: number };
        // Do not hard-code coordinates — only check it is one of the desk seats the map defines.
        assert.ok(
          captureSeats.seats.some((s) => s.col === seat.positionX && s.row === seat.positionY),
          `NPC 자리는 데스크 좌석이어야 한다: ${JSON.stringify(seat)}`,
        );
        assert.equal((body as { direction: string }).direction, "down");
        calls.push(sophie ? "seat:sophie" : "seat:noah");
        return { npc: { id: sophie ? "npc-sophie" : "npc-noah" } } as T;
      }
      if (method === "GET" && requestPath === "/api/channels/channel-1") {
        calls.push("channel-detail");
        return { channel: { id: "channel-1", mapData: captureMap, mapConfig: null } } as T;
      }
      if (method === "PUT" && requestPath === "/api/channels/channel-1") {
        const config = (body as { mapConfig: { spawnCol: number; spawnRow: number } }).mapConfig;
        // The spawn must be a standable cell and within conversation range (1 cell) of Sophie's seat.
        assert.ok(
          captureSeats.standing.some(
            (tile) => tile.col === config.spawnCol && tile.row === config.spawnRow,
          ),
          `스폰은 설 수 있는 칸이어야 한다: ${JSON.stringify(config)}`,
        );
        calls.push("spawn");
        return { channel: { id: "channel-1" } } as T;
      }
      if (method === "POST" && requestPath === "/api/channels") {
        calls.push("channel");
        assert.deepEqual(body, {
          name: "Dante Labs Office",
          description: "Hermes agents at work",
          isPublic: true,
          environmentId: "trading",
          groupId: "group-1",
          gatewayConfig: { gatewayId: "gateway-1" },
        });
        return { channel: { id: "channel-1" } } as T;
      }
      if (method === "GET" && requestPath === "/api/npcs?channelId=channel-1&roster=1") {
        calls.push("roster");
        return {
          npcs: [
            { id: "npc-sophie", name: "Sophie", positionX: 6, positionY: 5 },
            { id: "npc-noah", name: "Noah", positionX: 10, positionY: 5 },
          ],
        } as T;
      }
      if (method === "GET" && requestPath === "/api/channels/channel-1/kanban/board") {
        calls.push("board");
        return { columns: [] } as T;
      }
      if (method === "POST" && requestPath === "/api/channels/channel-1/kanban/tasks") {
        calls.push("report");
        assert.deepEqual(body, {
          title: "시네마틱 캡처 준비",
          body: "장면과 미디어 규격 점검을 완료했습니다.",
          assignee: "npc-sophie",
        });
        return { task: { id: "capture-card-1", status: "todo" } } as T;
      }
      throw new Error(`Unexpected fixture request: ${method} ${requestPath}`);
    },
  };
}

function withRuntime(): { root: string; sqlitePath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deskrpg-fixture-"));
  const sqlitePath = path.join(root, ".artifacts/readme-capture/runtime/data/db.sqlite");
  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
  return { root, sqlitePath };
}

test("places newly hired unplaced NPCs and sets deterministic profile appearances through the API", async (t) => {
  const { root, sqlitePath } = withRuntime();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const delegate = recordingFixtureApi([]);
  const writes: Array<{ method: string; path: string; body: unknown }> = [];
  const api: FixtureApi = {
    async request<T>(
      method: "GET" | "POST" | "PUT" | "PATCH",
      requestPath: string,
      body?: unknown,
    ): Promise<T> {
      if (method === "PUT" || method === "PATCH") writes.push({ method, path: requestPath, body });
      if (requestPath.includes("&roster=1"))
        return {
          npcs: [
            { id: "npc-sophie", name: "Sophie", positionX: null, positionY: null },
            { id: "npc-noah", name: "Noah", positionX: null, positionY: null },
          ],
        } as T;
      return delegate.request<T>(method, requestPath, body);
    },
  };
  await prepareFixture(api, "http://127.0.0.1:38642", sqlitePath);
  const puts = writes.filter((w) => w.method === "PUT");
  const spawnWrite = puts.find((w) => w.path === "/api/channels/channel-1");
  const seatWrites = puts.filter((w) => w.path.startsWith("/api/npcs/"));
  assert.ok(spawnWrite, "스폰을 좌석 옆으로 옮긴다");
  assert.equal(seatWrites.length, 2);
  const spawn = (spawnWrite.body as { mapConfig: { spawnCol: number; spawnRow: number } })
    .mapConfig;
  for (const seat of seatWrites) {
    const at = seat.body as { positionX: number; positionY: number; direction: string };
    assert.ok(
      captureSeats.seats.some((s) => s.col === at.positionX && s.row === at.positionY),
      `맵이 정한 데스크 좌석이어야 한다: ${JSON.stringify(at)}`,
    );
    assert.equal(at.direction, "down");
  }
  const sophieSeat = seatWrites[0].body as { positionX: number; positionY: number };
  const noahSeat = seatWrites[1].body as { positionX: number; positionY: number };
  // Conversation range is 64px (2 cells) — Noah must be next to the spawn so the capture starts with the room input open.
  assert.ok(
    Math.abs(spawn.spawnCol - noahSeat.positionX) <= 1 &&
      Math.abs(spawn.spawnRow - noahSeat.positionY) <= 1,
    `스폰이 Noah 좌석 옆이어야 한다: ${JSON.stringify({ spawn, noahSeat })}`,
  );
  // Sophie must be far away — the "호출하기" scene shows Sophie walking over.
  assert.ok(
    Math.hypot(sophieSeat.positionX - spawn.spawnCol, sophieSeat.positionY - spawn.spawnRow) > 3,
    `Sophie 는 스폰에서 멀어야 한다: ${JSON.stringify({ spawn, sophieSeat })}`,
  );
  const appearances = writes.filter((w) => w.method === "PATCH");
  assert.equal(appearances.length, 2);
  assert.notDeepEqual(appearances[0].body, appearances[1].body);
});

test("creates a user, character, channel, gateway, profiles and NPCs in dependency order", async (t) => {
  const { root, sqlitePath } = withRuntime();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls: string[] = [];

  const fixture = await prepareFixture(
    recordingFixtureApi(calls),
    "http://127.0.0.1:38642",
    sqlitePath,
  );

  assert.deepEqual(calls, [
    "register",
    "character",
    "gateway",
    "profile:sophie",
    "profile:noah",
    "group",
    "channel",
    "roster",
    "channel-detail",
    "spawn",
    "seat:sophie",
    "seat:noah",
    "board",
    "report",
  ]);
  assert.equal(fixture.channelId, "channel-1");
  assert.deepEqual(fixture.npcNames, ["Sophie", "Noah"]);

  assert.equal(
    fs.existsSync(sqlitePath),
    false,
    "fixture must not create a local card/report database",
  );
});

test("a second fixture run reuses an existing Hermes card without duplicating it", async (t) => {
  const { root, sqlitePath } = withRuntime();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = recordingFixtureApi([]);
  let created = false;
  let creations = 0;
  const api: FixtureApi = {
    async request<T>(
      method: "GET" | "POST" | "PUT" | "PATCH",
      requestPath: string,
      body?: unknown,
    ): Promise<T> {
      if (requestPath.endsWith("/kanban/board") && created)
        return {
          columns: [
            {
              name: "todo",
              tasks: [{ id: "capture-card-1", title: "시네마틱 캡처 준비", assignee: "sophie" }],
            },
          ],
        } as T;
      if (requestPath.endsWith("/kanban/tasks") && method === "POST") {
        created = true;
        creations += 1;
      }
      return base.request<T>(method, requestPath, body);
    },
  };
  const first = await prepareFixture(api, "http://127.0.0.1:38642", sqlitePath);
  const second = await prepareFixture(api, "http://127.0.0.1:38642", sqlitePath);

  assert.equal(second.channelId, first.channelId);
  assert.equal(creations, 1);
  assert.equal(
    fs.existsSync(sqlitePath),
    false,
    "fixture must not create a local card/report database",
  );
});

test("an interrupted run reuses the fixed account character and channel", async (t) => {
  const { root, sqlitePath } = withRuntime();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls: string[] = [];
  const base = recordingFixtureApi(calls);
  const api: FixtureApi = {
    async request<T>(
      method: "GET" | "POST" | "PUT" | "PATCH",
      requestPath: string,
      body?: unknown,
    ): Promise<T> {
      if (method === "POST" && requestPath === "/api/auth/register") {
        calls.push("register");
        return { user: { id: "user-1", nickname: "Dante" }, existing: true } as T;
      }
      if (method === "GET" && requestPath === "/api/characters") {
        calls.push("character:list");
        return { characters: [{ id: "character-1", name: "Dante" }] } as T;
      }
      if (method === "GET" && requestPath === "/api/channels") {
        calls.push("channel:list");
        return {
          channels: [{ id: "channel-1", name: "Dante Labs Office", ownerId: "user-1" }],
        } as T;
      }
      return base.request<T>(method, requestPath, body);
    },
  };

  const fixture = await prepareFixture(api, "http://127.0.0.1:38642", sqlitePath);

  assert.equal(fixture.channelId, "channel-1");
  assert.equal(calls.includes("character"), false);
  assert.equal(calls.includes("channel"), false);
  assert.deepEqual(calls, [
    "register",
    "character:list",
    "gateway",
    "profile:sophie",
    "profile:noah",
    "group",
    "channel:list",
    "roster",
    "channel-detail",
    "spawn",
    "seat:sophie",
    "seat:noah",
    "board",
    "report",
  ]);
});

test("never touches the removed map-template API", async (t) => {
  const { root, sqlitePath } = withRuntime();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = recordingFixtureApi([]);
  const paths: string[] = [];
  const api: FixtureApi = {
    async request<T>(
      method: "GET" | "POST" | "PUT" | "PATCH",
      requestPath: string,
      body?: unknown,
    ): Promise<T> {
      paths.push(requestPath);
      return base.request<T>(method, requestPath, body);
    },
  };

  await prepareFixture(api, "http://127.0.0.1:38642", sqlitePath);

  assert.equal(
    paths.some((entry) => entry.startsWith("/api/map-templates")),
    false,
    "채널 배치는 서버가 환경 ID 로 만든다 — 템플릿 API 를 부르지 않는다",
  );
});

test("refuses non-loopback gateway URLs before making requests", async () => {
  await assert.rejects(
    () =>
      prepareFixture(
        recordingFixtureApi([]),
        "https://deskrpg.com",
        "/repo/.artifacts/readme-capture/runtime/data/db.sqlite",
      ),
    /loopback/i,
  );
});

test("refuses SQLite paths outside the capture artifact runtime", async () => {
  await assert.rejects(
    () =>
      prepareFixture(recordingFixtureApi([]), "http://127.0.0.1:38642", "/tmp/production.sqlite"),
    /readme-capture runtime/i,
  );
});
