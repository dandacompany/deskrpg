import type { Server, Socket } from "socket.io";
import { parseMotionContinuation, type MotionContinuation } from "./npc-motion-continuation";
import type { MeetingSpatialTarget, SpatialMotionTarget } from "../lib/meeting-discussion-state";
import { insideMeetingSpace, type MeetingSpace } from "../game/meeting-space";
import { clearSegment, findPath } from "../game/navigation";
import { NPC_SPEED_RANGE } from "../lib/npc-motion-config";

export type NpcMotionPhase = "idle" | "called" | "waiting" | "returning" | "ambient";
export type NpcMotion = {
  npcId: string;
  x: number;
  y: number;
  homeX: number;
  homeY: number;
  direction: string;
  ownerSocketId: string | null;
  phase: NpcMotionPhase;
  moving: boolean;
  revision: number;
  continuation?: MotionContinuation | null;
  spatialTarget?: SpatialMotionTarget | null;
};
export type CoordinationChannel = {
  sanitizedHomes?: boolean;
  npcs: { id: string; x: number; y: number }[];
  seats: { id: string; x: number; y: number }[];
  bounds?: { width: number; height: number };
  meetingSpace?: MeetingSpace;
  canStandAt?: (point: { x: number; y: number }) => boolean;
  isWalkable?: (x: number, y: number) => boolean;
};
export type CoordinationDependencies = {
  getPlayer(
    socketId: string,
  ): { mapId: string; x?: number; y?: number; userId?: string; characterId?: string } | undefined;
  loadChannel(channelId: string): Promise<CoordinationChannel>;
  now?: () => number;
  onSpatialArrival?: (channelId: string, actorId: string, generation: number) => void;
  onSpatialBlocked?: (
    channelId: string,
    actorId: string,
    reason: string,
    generation: number,
  ) => void;
  onSpatialPlayerArrival?: (channelId: string, userId: string, socketId: string) => void;
  onSpatialPlayerBlocked?: (channelId: string, userId: string) => void;
};
type Reservation = {
  seatId: string;
  actorId: string;
  ownerSocketId: string;
  x: number;
  y: number;
  arrived: boolean;
  expires: number;
  spatial?: boolean;
};
type Channel = {
  source: Promise<Channel>;
  channelId: string;
  identities: Map<string, string>;
  disconnected: Map<
    string,
    { identity: string; expires: number; timer: ReturnType<typeof setTimeout> }
  >;
  data: CoordinationChannel;
  npcs: Map<string, NpcMotion>;
  reservations: Map<string, Reservation>;
  players: Map<string, { x: number; y: number }>;
  revision: number;
  excursions: Set<string>;
  ambientLeaderId: string | null;
};
type Ack = (result: { ok: boolean; error?: string; revision?: number; seatId?: string }) => void;
export const NPC_RECONNECT_GRACE_MS = 30_000;
export const NPC_IDLE_RETENTION_MS = 24 * 60 * 60 * 1000;
export const MAX_IDLE_NPC_CHANNELS = 256;
/**
 * If an owned move (call or meeting move) reports no progress for this long, the server confirms it as arrived.
 *
 * Walking is driven by rAF in one browser tab. When the tab is hidden the browser stops rAF, but the connection
 * stays alive, so the "no driver" settlement is never called and call/meeting gatherings froze at "moving"
 * (measured on staging). While walking, positions arrive several times a second, so 10s of silence means the walk stopped.
 */
export const STALLED_MOTION_MS = 10_000;
const STALL_SWEEP_INTERVAL_MS = 2_000;
const directions = new Set(["up", "down", "left", "right"]);
const distance = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y);
/**
 * Has the person arrived at their reserved seat? The move handler's arrival notice and the meeting gathering's
 * "already seated" check must use **the same rule** — if they diverge, one side sees arrived and the other sees moving.
 */
const PLAYER_ARRIVAL_RADIUS = 2;
const atReservationPoint = (
  reservation: { x: number; y: number },
  position: { x: number; y: number },
) => distance(reservation, position) <= PLAYER_ARRIVAL_RADIUS;

/** Process-local authority. DB homes and seat anchors are inputs; no pathfinding or AI calls. */
export function createNpcCoordination(io: Server, dependencies: CoordinationDependencies) {
  const channels = new Map<string, Promise<Channel>>();
  // Keep the revision watermark across reset: fresh geometry must outrank any
  // snapshot clients received before the refresh.
  const revisions = new Map<string, number>();
  const nextRevision = (id: string) => {
    const revision = (revisions.get(id) ?? -1) + 1;
    revisions.set(id, revision);
    return revision;
  };
  const isCurrent = (state: Channel) => channels.get(state.channelId) === state.source;
  const now = dependencies.now ?? Date.now;
  const spatialLastMotion = new Map<string, number>();
  const spatialMotionCredit = new Map<string, number>();
  const validatedPlayers = new Map<string, { x: number; y: number }>();
  // Upper bound on NPC movement the server accepts (px/s). The capture runtime walks faster, so the cap goes up too
  // — paired with the client's `captureWalkSpeed`.
  //
  // It used to be fixed at 180 — 1.2x the only walk speed, 150. Once walk speed became a channel setting,
  // the meeting call default (300) exceeded this cap, the server rejected seat moves, and the gathering froze
  // at "moving" forever (measured locally: 150 fine, 300 stuck). Instead of reading the cap per channel from settings,
  // set it to **1.2x the highest configurable speed** — it blocks no channel setting without DB reads or cache
  // invalidation on setting changes. Teleport prevention (the accumulated credit below) stays as is.
  // The capture multiplier 3 is `CAPTURE_WALK_MULTIPLIER` in `npc-controller.ts`. It is kept as a number to avoid
  // pulling that module into the server (as it was originally).
  const NPC_SPEED_CAP =
    NPC_SPEED_RANGE.max * 1.2 * (process.env.DESKRPG_CAPTURE_MODE === "1" ? 3 : 1);
  const consumeMotion = (key: string, separation: number, speed: number) => {
    const elapsed = Math.max(0, (now() - (spatialLastMotion.get(key) ?? now())) / 1000);
    const credit = Math.min(speed, (spatialMotionCredit.get(key) ?? 8) + elapsed * speed);
    spatialLastMotion.set(key, now());
    if (separation > credit) {
      spatialMotionCredit.set(key, credit);
      return false;
    }
    spatialMotionCredit.set(key, credit - separation);
    return true;
  };
  const inactive = new Map<
    string,
    { startedAt: number; expires: number; timer: ReturnType<typeof setTimeout> }
  >();
  const identity = (socketId: string, channelId: string) => {
    const player = dependencies.getPlayer(socketId);
    return player?.userId && player.characterId
      ? JSON.stringify([player.userId, player.characterId, channelId])
      : undefined;
  };
  const cancelInactive = (channelId: string) => {
    const entry = inactive.get(channelId);
    if (entry) clearTimeout(entry.timer);
    inactive.delete(channelId);
  };
  const evict = (channelId: string) => {
    cancelInactive(channelId);
    // Do not reuse the previous position validation and movement budget on a new map.
    for (const cache of [validatedPlayers, spatialLastMotion, spatialMotionCredit])
      for (const key of cache.keys()) if (key.startsWith(`${channelId}:`)) cache.delete(key);
    const pending = channels.get(channelId);
    channels.delete(channelId);
    void pending
      ?.then((state) => {
        for (const departure of state.disconnected.values()) clearTimeout(departure.timer);
      })
      .catch(() => {});
  };
  const retainInactive = (channelId: string) => {
    if (inactive.has(channelId)) return;
    const expires = now() + NPC_IDLE_RETENTION_MS;
    const timer = setTimeout(() => {
      if (inactive.get(channelId)?.expires === expires && !members(channelId).length)
        evict(channelId);
    }, NPC_IDLE_RETENTION_MS);
    timer.unref();
    inactive.set(channelId, { startedAt: now(), expires, timer });
    while (inactive.size > MAX_IDLE_NPC_CHANNELS) evict(inactive.keys().next().value!);
  };
  const member = (socket: Socket, channelId: unknown): channelId is string =>
    typeof channelId === "string" &&
    dependencies.getPlayer(socket.id)?.mapId === channelId &&
    socket.rooms.has(channelId);
  const members = (channelId: string, exclude?: string) =>
    [...(io.sockets.adapter.rooms.get(channelId) ?? [])]
      .filter(
        (id) =>
          id !== exclude &&
          dependencies.getPlayer(id)?.mapId === channelId &&
          io.sockets.sockets.get(id)?.connected,
      )
      .sort();
  const leader = (channelId: string, exclude?: string) => members(channelId, exclude)[0] ?? null;
  const create = (
    data: CoordinationChannel,
    channelId: string,
    source: Promise<Channel>,
  ): Channel => {
    const revision = nextRevision(channelId);
    return {
      channelId,
      source,
      identities: new Map(),
      disconnected: new Map(),
      data,
      revision,
      excursions: new Set(),
      ambientLeaderId: null,
      reservations: new Map(),
      players: new Map(),
      npcs: new Map(
        data.npcs.map((npc) => [
          npc.id,
          {
            npcId: npc.id,
            x: npc.x,
            y: npc.y,
            homeX: npc.x,
            homeY: npc.y,
            direction: "down",
            ownerSocketId: null,
            phase: "idle",
            moving: false,
            revision,
          },
        ]),
      ),
    };
  };
  const load = (channelId: string) => {
    if ((inactive.get(channelId)?.expires ?? Infinity) <= now()) evict(channelId);
    let pending = channels.get(channelId);
    if (!pending) {
      const replacement: Promise<Channel> = dependencies.loadChannel(channelId).then((data) => {
        if (channels.get(channelId) !== replacement) throw Error("Stale channel load");
        return create(data, channelId, replacement);
      });
      pending = replacement;
      channels.set(channelId, pending);
      void pending.catch(() => {
        if (channels.get(channelId) === pending) channels.delete(channelId);
      });
    }
    return pending;
  };
  const prune = (state: Channel) => {
    for (const [socketId, departure] of state.disconnected) {
      if (departure.expires > now()) continue;
      clearTimeout(departure.timer);
      state.disconnected.delete(socketId);
      state.identities.delete(socketId);
      for (const [seatId, reservation] of state.reservations) {
        if (
          reservation.ownerSocketId === socketId &&
          !reservation.spatial &&
          state.npcs.get(reservation.actorId)?.phase !== "ambient"
        ) {
          state.reservations.delete(seatId);
          state.revision = nextRevision(state.channelId);
        }
      }
      for (const npc of state.npcs.values()) {
        if (npc.ownerSocketId !== socketId) continue;
        if (npc.spatialTarget) {
          const heir = leader(state.channelId);
          if (heir) {
            npc.ownerSocketId = heir;
            npc.moving = true;
            changed(state, npc);
          } else settleDriverlessSpatial(state, npc, state.channelId);
          continue;
        }
        npc.ownerSocketId = leader(state.channelId);
        npc.phase = "returning";
        npc.continuation = null;
        npc.moving = !!npc.ownerSocketId;
        state.revision = nextRevision(state.channelId);
        npc.revision = state.revision;
      }
    }
    if (inactive.has(state.channelId)) return;
    for (const [id, reservation] of state.reservations)
      if (!reservation.spatial && !reservation.arrived && reservation.expires <= now()) {
        state.reservations.delete(id);
        state.revision = nextRevision(state.channelId);
        const npc = state.npcs.get(reservation.actorId);
        if (
          npc?.phase === "ambient" &&
          !npc.moving &&
          distance(npc, { x: npc.homeX, y: npc.homeY }) <= 2
        ) {
          state.excursions.delete(npc.npcId);
          npc.phase = "idle";
          npc.revision = state.revision;
        }
      }
  };
  const snapshot = (channelId: string, state: Channel) => {
    prune(state);
    return {
      channelId,
      protocolVersion: 1,
      revision: state.revision,
      ambientLeaderId: leader(channelId),
      npcs: [...state.npcs.values()].map((npc) => ({ ...npc })),
      seats: [...state.reservations.values()].map(
        ({ seatId, actorId, ownerSocketId, x, y, spatial }) => ({
          seatId,
          actorId,
          ownerSocketId,
          x,
          y,
          ...(spatial ? { spatial: true } : {}),
        }),
      ),
    };
  };
  const broadcast = (channelId: string, state: Channel) => {
    if (!isCurrent(state)) return;
    state.ambientLeaderId = leader(channelId);
    return io.to(channelId).emit("npc:motion-state", snapshot(channelId, state));
  };
  // channel:NPC → the last time the authoritative state changed. Position notices, calls and move starts all go
  // through `changed`, so stamping here gathers the definition of "there was progress" in one place.
  const motionAt = new Map<string, number>();
  const changed = (state: Channel, npc?: NpcMotion) => {
    state.revision = nextRevision(state.channelId);
    if (npc) {
      npc.revision = state.revision;
      motionAt.set(`${state.channelId}:${npc.npcId}`, now());
    }
  };
  const releaseActor = (state: Channel, actorId: string) => {
    for (const [id, seat] of state.reservations)
      if (seat.actorId === actorId) {
        state.reservations.delete(id);
        changed(state);
      }
  };
  /**
   * **Settles only the outcome** of a meeting move that has no browser to drive it.
   *
   * For a meeting move (`spatial.move`) the server only pins the target and the owning browser advances the walk —
   * as this file's header says, the server does not run paths. So when the driver disappears the walk stops,
   * and since the resume loop only looks at phase `returning`, meeting moves (`called`) froze permanently.
   * This always happened when a solo user left, and the meeting seats stayed occupied so the next meeting
   * could not open either.
   *
   * There is no reason to replay a walk nobody is watching. Move to the target coordinates, confirm the reservation
   * as arrived and advance the meeting session (`onSpatialArrival`). When the user returns, the NPC is already in place.
   */
  const settleSpatial = (
    state: Channel,
    npc: NpcMotion,
    channelId: string,
    at: { x: number; y: number },
  ) => {
    const target = npc.spatialTarget;
    npc.x = at.x;
    npc.y = at.y;
    npc.spatialTarget = null;
    npc.continuation = null;
    npc.moving = false;
    npc.ownerSocketId = null;
    npc.phase = "idle";
    state.excursions.delete(npc.npcId);
    for (const reservation of state.reservations.values())
      if (reservation.actorId === npc.npcId) {
        reservation.x = at.x;
        reservation.y = at.y;
        reservation.arrived = true;
        reservation.spatial = false;
        reservation.expires = now() + 60_000;
      }
    changed(state, npc);
    if (target) dependencies.onSpatialArrival?.(channelId, npc.npcId, target.generation);
  };
  /**
   * Decides how to finish a meeting move whose driver disappeared.
   *
   * - If **returning to its seat**, settle to the target (original seat or substitute standing spot).
   * - If **heading into the meeting**, the meeting cannot proceed without the user, so block the session
   *   (`driver_disconnected`), but instead of freezing the NPC mid-walk, settle it **back in place** and
   *   release the meeting seat reservation. Otherwise the next meeting will not open either.
   */
  const settleDriverlessSpatial = (state: Channel, npc: NpcMotion, channelId: string) => {
    const target = npc.spatialTarget;
    if (!target) return;
    if (target.returning) {
      settleSpatial(state, npc, channelId, target);
      return;
    }
    const generation = target.generation;
    releaseActor(state, npc.npcId);
    settleSpatial(state, npc, channelId, { x: npc.homeX, y: npc.homeY });
    dependencies.onSpatialBlocked?.(channelId, npc.npcId, "driver_disconnected", generation);
  };
  const validPoint = (state: Channel, x: unknown, y: unknown): boolean =>
    typeof x === "number" &&
    typeof y === "number" &&
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    x >= 0 &&
    y >= 0 &&
    (!state.data.bounds || (x < state.data.bounds.width && y < state.data.bounds.height));
  const updateReservation = (
    state: Channel,
    actorId: string,
    position: { x: number; y: number },
  ) => {
    for (const [id, seat] of state.reservations)
      if (seat.actorId === actorId) {
        const separation = distance(seat, position);
        if (seat.arrived && separation > 20) {
          state.reservations.delete(id);
          changed(state);
        } else {
          if (separation <= 8) seat.arrived = true;
          seat.expires = now() + 60_000;
        }
      }
  };
  async function authorized(socket: Socket, channelId: unknown) {
    if (!member(socket, channelId)) return null;
    const pending = load(channelId);
    const state = await pending;
    // A map reset can finish while this load is pending. The old promise must
    // never regain authority, even if the same socket has already rejoined.
    return channels.get(channelId) === pending && member(socket, channelId) && socket.connected
      ? state
      : null;
  }
  function register(socket: Socket) {
    const handle = (
      name: string,
      action: (
        payload: Record<string, unknown>,
        state: Channel,
        channelId: string,
      ) => { error?: string; seatId?: string } | void,
    ) => {
      socket.on(name, async (raw: unknown, ack?: Ack) => {
        const reply = (result: Parameters<Ack>[0]) => {
          if (typeof ack === "function") ack(result);
        };
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
          reply({ ok: false, error: "invalid_payload" });
          return;
        }
        const payload = raw as Record<string, unknown>;
        try {
          const state = await authorized(socket, payload.channelId);
          if (
            !state ||
            !isCurrent(state) ||
            !member(socket, payload.channelId) ||
            !socket.connected
          ) {
            reply({ ok: false, error: "forbidden" });
            return;
          }
          const channelId = payload.channelId as string;
          prune(state);
          const result = action(payload, state, channelId);
          if (result?.error) {
            socket.emit("npc:motion-state", snapshot(channelId, state));
            reply({ ok: false, error: result.error });
          } else
            reply({
              ok: true,
              revision: state.revision,
              ...(result?.seatId ? { seatId: result.seatId } : {}),
            });
        } catch {
          reply({ ok: false, error: "unavailable" });
        }
      });
    };
    handle("npc:call", (payload, state, channelId) => {
      const npc = state.npcs.get(String(payload.npcId));
      if (!npc) return { error: "unknown_npc" };
      if (npc.spatialTarget) return { error: "meeting_reserved" };
      // There are two states in which someone else's ownership can be taken over.
      //
      // - `ambient`: the ownership is not "in conversation" but a driver running the stroll walk (existing rule).
      // - `returning`: on the way back to its seat — nobody is talking to it. In particular, when the reconnect grace
      //   ends, `prune` hands ownership to the remaining leader and sets phase to `returning`; if that
      //   leader were treated as owner, **an employee nobody called could not be called by anyone.**
      //
      // However, the homebound takeover is only allowed for **calls a person pressed**. If calls the room runtime
      // fires automatically every conversation turn (`reason: "map-chat"`) were allowed too, the conversation would
      // keep pulling back an NPC someone else sent home — that rule is guarded by the
      // "legacy room intent … preserves competing ownership" test.
      //
      // **This distinction is not a security boundary.** `reason` is a client-supplied value, so omitting it
      // gets treated as a person-pressed call. Right now there is nothing to gain since a member of the same channel
      // can do that with the call button anyway, but if calls get permission tiers this one line will not stop it —
      // then it must be split on a fact the server knows (whether the room runtime started the call).
      const roomTurn = payload.reason === "map-chat";
      if (
        npc.ownerSocketId &&
        npc.ownerSocketId !== socket.id &&
        npc.phase !== "ambient" &&
        !(npc.phase === "returning" && !roomTurn)
      )
        return { error: "already_claimed" };
      // Even if I am already the owner, treat it as a **re-call**. Previously this just broadcast and quietly
      // turned back, `npc:come-to-player` was never sent and nobody moved — with no error either.
      // Reconnecting with the same identity moves ownership to the new socket (`rebindOwner`), so opening
      // a new tab and calling, a common flow, hit exactly this branch. Merge into the single path below.
      releaseActor(state, npc.npcId);
      state.excursions.delete(npc.npcId);
      Object.assign(npc, {
        ownerSocketId: socket.id,
        phase: "called",
        moving: true,
        continuation: null,
      });
      changed(state, npc);
      broadcast(channelId, state);
      io.to(channelId).emit("npc:come-to-player", {
        npcId: npc.npcId,
        targetPlayerId: socket.id,
        ...(payload.reason === "map-chat"
          ? {
              reason: "map-chat",
              ...(typeof payload.roomId === "string" ? { roomId: payload.roomId } : {}),
            }
          : {}),
      });
    });
    handle("npc:return-home", (payload, state, channelId) => {
      const npc = state.npcs.get(String(payload.npcId));
      if (!npc) return { error: "unknown_npc" };
      if (npc.spatialTarget) return { error: "meeting_reserved" };
      if (
        npc.ownerSocketId !== socket.id &&
        !(npc.phase === "ambient" && leader(channelId) === socket.id)
      )
        return { error: "not_owner" };
      releaseActor(state, npc.npcId);
      npc.ownerSocketId = socket.id;
      npc.phase = "returning";
      npc.continuation = null;
      npc.moving = true;
      changed(state, npc);
      broadcast(channelId, state);
      io.to(channelId).emit("npc:returning", { npcId: npc.npcId });
    });
    handle("npc:position-update", (payload, state, channelId) => {
      const npc = state.npcs.get(String(payload.npcId));
      if (!npc) return { error: "unknown_npc" };
      if (!validPoint(state, payload.x, payload.y) || !directions.has(String(payload.direction)))
        return { error: "invalid_motion" };
      const continuation = parseMotionContinuation(payload.continuation, state.data.bounds);
      if (!continuation.ok) return { error: "invalid_continuation" };
      if (npc.phase === "idle" || npc.phase === "ambient") {
        if (leader(channelId) !== socket.id) return { error: "not_owner" };
        if (npc.phase === "idle" && (payload.x !== npc.homeX || payload.y !== npc.homeY)) {
          if (state.excursions.size >= 2) return { error: "ambient_limit" };
          state.excursions.add(npc.npcId);
          npc.phase = "ambient";
        }
        npc.ownerSocketId = null;
      } else if (npc.ownerSocketId !== socket.id) return { error: "not_owner" };
      if (npc.spatialTarget) {
        const destination = { x: payload.x as number, y: payload.y as number };
        if (
          !consumeMotion(`${channelId}:${npc.npcId}`, distance(npc, destination), NPC_SPEED_CAP) ||
          (state.data.isWalkable &&
            !clearSegment(
              { x: npc.x / 32 - 0.5, y: npc.y / 32 - 0.5 },
              { x: destination.x / 32 - 0.5, y: destination.y / 32 - 0.5 },
              state.data.isWalkable,
            ))
        )
          return { error: "invalid_motion" };
        spatialLastMotion.set(`${channelId}:${npc.npcId}`, now());
      }
      if (continuation.value !== undefined) npc.continuation = continuation.value;
      npc.x = payload.x as number;
      npc.y = payload.y as number;
      npc.direction = payload.direction as string;
      npc.moving = npc.phase !== "idle";
      updateReservation(state, npc.npcId, npc);
      changed(state, npc);
      broadcast(channelId, state);
      socket.to(channelId).emit("npc:position-sync", {
        npcId: npc.npcId,
        x: npc.x,
        y: npc.y,
        direction: npc.direction,
      });
    });
    handle("npc:continuation-update", (payload, state, channelId) => {
      const npc = state.npcs.get(String(payload.npcId));
      if (!npc) return { error: "unknown_npc" };
      if (
        npc.ownerSocketId !== socket.id &&
        !(
          npc.ownerSocketId === null &&
          (npc.phase === "idle" || npc.phase === "ambient") &&
          leader(channelId) === socket.id
        )
      )
        return { error: "not_owner" };
      const continuation = parseMotionContinuation(payload.continuation, state.data.bounds);
      if (!continuation.ok) return { error: "invalid_continuation" };
      if (continuation.value !== undefined) {
        npc.continuation = continuation.value;
        changed(state, npc);
        broadcast(channelId, state);
      }
    });
    handle("npc:arrived", (payload, state, channelId) => {
      const npc = state.npcs.get(String(payload.npcId));
      if (!npc) return { error: "unknown_npc" };
      if (npc.spatialTarget) {
        const target = npc.spatialTarget;
        if (npc.ownerSocketId !== socket.id) return { error: "not_owner" };
        if (payload.generation !== target.generation) return { error: "stale_generation" };
        if (distance(npc, target) > 2) return { error: "not_at_target" };
        const reservation = [...state.reservations.values()].find(
          (r) => r.actorId === npc.npcId && r.x === target.x && r.y === target.y,
        );
        if (!reservation || !reservation.arrived) return { error: "reservation_lost" };
        npc.moving = false;
        npc.phase = "waiting";
        if (target.returning) {
          npc.spatialTarget = null;
          npc.phase = distance(npc, { x: npc.homeX, y: npc.homeY }) <= 2 ? "idle" : "ambient";
          npc.ownerSocketId = null;
          if (npc.phase === "idle") state.excursions.delete(npc.npcId);
          else state.excursions.add(npc.npcId);
          if (!target.seatId || npc.phase === "idle") releaseActor(state, npc.npcId);
          else {
            // After a verified return arrival, hand over to the regular seat reservation.
            reservation.spatial = false;
            reservation.expires = now() + 60_000;
          }
        }
        changed(state, npc);
        broadcast(channelId, state);
        dependencies.onSpatialArrival?.(channelId, npc.npcId, target.generation);
        return;
      }
      if (npc.phase === "idle" && leader(channelId) === socket.id) {
        broadcast(channelId, state);
        socket.to(channelId).emit("npc:stop-moving", { npcId: npc.npcId });
        return;
      }
      if (
        npc.ownerSocketId !== socket.id &&
        !(npc.phase === "ambient" && leader(channelId) === socket.id)
      )
        return { error: "not_owner" };
      if (npc.phase === "returning" && distance(npc, { x: npc.homeX, y: npc.homeY }) > 2)
        return { error: "not_at_home" };
      npc.moving = false;
      if (npc.phase === "called") npc.phase = "waiting";
      else if (
        npc.phase === "returning" ||
        (npc.phase === "ambient" && distance(npc, { x: npc.homeX, y: npc.homeY }) <= 2)
      ) {
        npc.phase = "idle";
        npc.ownerSocketId = null;
        state.excursions.delete(npc.npcId);
        releaseActor(state, npc.npcId);
      }
      changed(state, npc);
      broadcast(channelId, state);
      socket.to(channelId).emit("npc:stop-moving", { npcId: npc.npcId });
    });
    handle("seat:claim", (payload, state, channelId) => {
      const seat = state.data.seats.find((seat) => seat.id === payload.seatId);
      if (!seat) return { error: "unknown_seat" };
      const actorId = typeof payload.actorId === "string" ? payload.actorId : socket.id;
      const npc = state.npcs.get(actorId);
      if (npc?.spatialTarget) return { error: "meeting_reserved" };
      if (
        actorId !== socket.id &&
        (!npc ||
          (npc.ownerSocketId !== socket.id &&
            !(
              npc.ownerSocketId === null &&
              (npc.phase === "idle" || npc.phase === "ambient") &&
              leader(channelId) === socket.id
            )))
      )
        return { error: "not_owner" };
      const spatialReservation = [...state.reservations.values()].find(
        (reservation) => reservation.actorId === actorId && reservation.spatial,
      );
      if (spatialReservation)
        return spatialReservation.seatId === seat.id &&
          spatialReservation.ownerSocketId === socket.id
          ? { seatId: seat.id }
          : { error: "meeting_reserved" };
      const existing = state.reservations.get(seat.id);
      if (existing && (existing.actorId !== actorId || existing.ownerSocketId !== socket.id))
        return { error: "seat_occupied" };
      const occupied =
        [...state.npcs.values()].some(
          (other) => other.npcId !== actorId && distance(other, seat) < 16,
        ) ||
        [...state.players].some(
          ([id, position]) => id !== actorId && distance(position, seat) < 16,
        );
      if (occupied) return { error: "seat_occupied" };
      if (npc && npc.phase === "idle") {
        if (state.excursions.size >= 2) return { error: "ambient_limit" };
        state.excursions.add(npc.npcId);
        npc.phase = "ambient";
        changed(state, npc);
      }
      releaseActor(state, actorId);
      const position = npc ?? state.players.get(socket.id);
      state.reservations.set(seat.id, {
        seatId: seat.id,
        actorId,
        ownerSocketId: socket.id,
        x: seat.x,
        y: seat.y,
        arrived: !!position && distance(position, seat) <= 8,
        expires: now() + 60_000,
      });
      changed(state);
      broadcast(channelId, state);
      return { seatId: seat.id };
    });
    handle("seat:release", (payload, state, channelId) => {
      const actorId = typeof payload.actorId === "string" ? payload.actorId : socket.id;
      const npc = state.npcs.get(actorId);
      if (npc?.spatialTarget) return { error: "meeting_reserved" };
      if (
        actorId !== socket.id &&
        npc?.ownerSocketId !== socket.id &&
        !(npc?.phase === "ambient" && leader(channelId) === socket.id)
      )
        return { error: "not_owner" };
      if ([...state.reservations.values()].some((r) => r.actorId === actorId && r.spatial))
        return { error: "meeting_reserved" };
      releaseActor(state, actorId);
      if (
        npc?.phase === "ambient" &&
        !npc.moving &&
        distance(npc, { x: npc.homeX, y: npc.homeY }) <= 2
      ) {
        npc.phase = "idle";
        state.excursions.delete(npc.npcId);
        changed(state, npc);
      }
      broadcast(channelId, state);
    });
    handle("npc:spatial-failed", (payload, state, channelId) => {
      const npc = state.npcs.get(String(payload.npcId));
      if (!npc?.spatialTarget || npc.ownerSocketId !== socket.id) return { error: "not_owner" };
      if (payload.generation !== npc.spatialTarget.generation) return { error: "stale_generation" };
      npc.moving = false;
      dependencies.onSpatialBlocked?.(
        channelId,
        npc.npcId,
        "path_unavailable",
        npc.spatialTarget.generation,
      );
      changed(state, npc);
      broadcast(channelId, state);
    });
    socket.on("disconnecting", () => {
      for (const channelId of socket.rooms)
        if (channelId !== socket.id) void left(socket, channelId);
    });
  }
  const rebindOwner = (state: Channel, oldId: string, newId: string) => {
    const departure = state.disconnected.get(oldId);
    if (departure) clearTimeout(departure.timer);
    state.disconnected.delete(oldId);
    state.identities.delete(oldId);
    for (const npc of state.npcs.values()) {
      if (npc.ownerSocketId === oldId) {
        npc.ownerSocketId = newId;
        changed(state, npc);
      }
    }
    for (const reservation of state.reservations.values()) {
      if (
        reservation.ownerSocketId !== oldId ||
        state.npcs.get(reservation.actorId)?.phase === "ambient"
      )
        continue;
      reservation.ownerSocketId = newId;
      if (reservation.actorId === oldId) reservation.actorId = newId;
      reservation.expires = now() + 60_000;
      changed(state);
    }
  };
  async function joined(socket: Socket, channelId: string) {
    const state = await authorized(socket, channelId);
    if (state && isCurrent(state) && member(socket, channelId) && socket.connected) {
      const dormant = inactive.get(channelId);
      if (dormant) {
        const paused = Math.max(0, now() - dormant.startedAt);
        for (const seat of state.reservations.values()) if (!seat.arrived) seat.expires += paused;
      }
      cancelInactive(channelId);
      prune(state);
      const key = identity(socket.id, channelId);
      if (key) {
        for (const [oldId, departure] of state.disconnected) {
          if (departure.identity !== key) continue;
          rebindOwner(state, oldId, socket.id);
        }
        state.identities.set(socket.id, key);
      }
      const player = dependencies.getPlayer(socket.id);
      if (player && validPoint(state, player.x, player.y))
        state.players.set(socket.id, { x: player.x!, y: player.y! });
      if (player && validPoint(state, player.x, player.y)) {
        validatedPlayers.set(`${channelId}:${socket.id}`, { x: player.x!, y: player.y! });
        spatialLastMotion.set(`${channelId}:${socket.id}`, now());
      }
      const currentLeader = leader(channelId);
      for (const npc of state.npcs.values()) {
        // NPCs with a pending meeting move are also resume targets. Previously only phase `returning` was checked,
        // so a meeting return with phase `called` was never resumed even after rejoining.
        if (npc.spatialTarget && !npc.ownerSocketId && currentLeader) {
          npc.ownerSocketId = currentLeader;
          npc.moving = true;
          changed(state, npc);
          continue;
        }
        if (npc.phase === "returning" && !npc.ownerSocketId && currentLeader) {
          npc.ownerSocketId = currentLeader;
          npc.moving = true;
          changed(state, npc);
        }
      }
      for (const seat of state.reservations.values())
        if (state.npcs.get(seat.actorId)?.phase === "ambient" && currentLeader)
          seat.ownerSocketId = currentLeader;
      broadcast(channelId, state);
    }
  }
  async function moved(socket: Socket, x: number, y: number) {
    const channelId = dependencies.getPlayer(socket.id)?.mapId;
    const state = await authorized(socket, channelId);
    if (
      !state ||
      !isCurrent(state) ||
      !member(socket, channelId) ||
      !socket.connected ||
      !validPoint(state, x, y)
    )
      return;
    const reservation = [...state.reservations.values()].find(
      (r) => r.actorId === socket.id && r.spatial,
    );
    {
      const key = `${channelId}:${socket.id}`;
      const previous = validatedPlayers.get(key);
      if (
        previous &&
        (!consumeMotion(key, distance(previous, { x, y }), 220) ||
          (state.data.isWalkable &&
            !clearSegment(
              { x: previous.x / 32 - 0.5, y: previous.y / 32 - 0.5 },
              { x: x / 32 - 0.5, y: y / 32 - 0.5 },
              state.data.isWalkable,
            )))
      ) {
        if (reservation) return;
      } else validatedPlayers.set(key, { x, y });
      spatialLastMotion.set(key, now());
    }
    const revision = state.revision;
    state.players.set(socket.id, { x, y });
    prune(state);
    if (reservation?.arrived && distance(reservation, { x, y }) > 20) {
      const userId = dependencies.getPlayer(socket.id)?.userId;
      if (userId) dependencies.onSpatialPlayerBlocked?.(channelId!, userId);
    }
    updateReservation(state, socket.id, { x, y });
    if (reservation && atReservationPoint(reservation, { x, y })) {
      const userId = dependencies.getPlayer(socket.id)?.userId;
      if (userId) dependencies.onSpatialPlayerArrival?.(channelId!, userId, socket.id);
    }
    if (state.revision !== revision) broadcast(channelId!, state);
  }
  async function left(socket: Socket, channelId: string) {
    const pending = channels.get(channelId);
    if (!pending) return;
    // Mark dormancy before awaiting an in-flight map refresh; its completion
    // must retain the shared state rather than evicting it as an unused preload.
    if (!members(channelId, socket.id).length) retainInactive(channelId);
    let state: Channel;
    try {
      state = await pending;
    } catch {
      return;
    }
    if (!isCurrent(state)) return;
    state.players.delete(socket.id);
    validatedPlayers.delete(`${channelId}:${socket.id}`);
    spatialLastMotion.delete(`${channelId}:${socket.id}`);
    spatialMotionCredit.delete(`${channelId}:${socket.id}`);
    const next = leader(channelId, socket.id);
    const key = state.identities.get(socket.id);
    const replacement =
      key && members(channelId, socket.id).find((id) => state.identities.get(id) === key);
    if (replacement) rebindOwner(state, socket.id, replacement);
    if (key && !replacement && !state.disconnected.has(socket.id)) {
      const timer = setTimeout(() => {
        void channels
          .get(channelId)
          ?.then((current) => {
            if (!isCurrent(current)) return;
            const revision = current.revision;
            prune(current);
            if (current.revision !== revision && members(channelId).length)
              broadcast(channelId, current);
          })
          .catch(() => {});
      }, NPC_RECONNECT_GRACE_MS);
      timer.unref();
      state.disconnected.set(socket.id, {
        identity: key,
        expires: now() + NPC_RECONNECT_GRACE_MS,
        timer,
      });
    }
    for (const [id, reservation] of state.reservations) {
      if (reservation.ownerSocketId !== socket.id) continue;
      if (state.npcs.get(reservation.actorId)?.phase === "ambient") {
        // The actor owns its reservation; its elected browser driver is replaceable.
        if (next) reservation.ownerSocketId = next;
      } else if (!key) {
        state.reservations.delete(id);
      }
      changed(state);
    }
    for (const npc of state.npcs.values()) {
      if (npc.ownerSocketId === socket.id && npc.spatialTarget && !replacement) {
        if (next) {
          // Another browser remains — hand over the walk and keep going. No reason to kill the session.
          npc.ownerSocketId = next;
          npc.moving = true;
          changed(state, npc);
          continue;
        }
        settleDriverlessSpatial(state, npc, channelId);
        continue;
      }
      if (npc.ownerSocketId === socket.id && !key) {
        npc.ownerSocketId = next;
        npc.phase = "returning";
        npc.moving = !!next;
        changed(state, npc);
      }
    }
    state.ambientLeaderId = next;
    if (!members(channelId, socket.id).length) {
      retainInactive(channelId);
      return;
    }
    broadcast(channelId, state);
  }
  async function invalidate(channelId: string) {
    const pending = channels.get(channelId);
    if (!pending) return;
    let old: Channel;
    try {
      old = await pending;
    } catch {
      return;
    }
    if (
      channels.get(channelId) !== pending ||
      (!members(channelId).length && !inactive.has(channelId))
    ) {
      if (channels.get(channelId) === pending) channels.delete(channelId);
      return;
    }
    const replacement: Promise<Channel> = dependencies.loadChannel(channelId).then((data) => {
      if (channels.get(channelId) !== replacement) throw Error("Stale channel invalidation");
      const state = create(data, channelId, replacement);
      state.identities = old.identities;
      state.disconnected = old.disconnected;
      state.players = old.players;
      state.excursions = new Set([...old.excursions].filter((id) => state.npcs.has(id)));
      const reallocated = new Set<string>();
      for (const [id, npc] of state.npcs) {
        const previous = old.npcs.get(id);
        if (
          data.sanitizedHomes &&
          previous &&
          (previous.homeX !== npc.homeX || previous.homeY !== npc.homeY)
        ) {
          // Roster allocation can move an invalid persisted home. The old seat,
          // live position and continuation may now belong to another actor.
          reallocated.add(id);
          state.excursions.delete(id);
          npc.revision = state.revision;
        } else if (previous)
          state.npcs.set(id, { ...previous, homeX: npc.homeX, homeY: npc.homeY });
        const target = previous?.spatialTarget;
        if (
          target &&
          (reallocated.has(id) ||
            (target.seatId && !data.seats.some((s) => s.id === target.seatId)) ||
            (data.canStandAt && !data.canStandAt(target)))
        ) {
          state.npcs.get(id)!.moving = false;
          dependencies.onSpatialBlocked?.(
            channelId,
            id,
            "destination_invalidated",
            target.generation,
          );
        }
      }
      for (const [id, reservation] of old.reservations)
        if (
          !reallocated.has(reservation.actorId) &&
          (data.seats.some((seat) => seat.id === id) ||
            (reservation.spatial && data.canStandAt?.(reservation))) &&
          (state.npcs.has(reservation.actorId) ||
            state.disconnected.has(reservation.actorId) ||
            members(channelId).includes(reservation.actorId))
        )
          state.reservations.set(id, reservation);
      for (const [id, previous] of old.npcs) {
        if (previous.spatialTarget && !state.npcs.has(id))
          dependencies.onSpatialBlocked?.(
            channelId,
            id,
            "actor_unavailable",
            previous.spatialTarget.generation,
          );
      }
      return state;
    });
    channels.set(channelId, replacement);
    try {
      const state = await replacement;
      if (!isCurrent(state)) return;
      if (!members(channelId).length) {
        if (!inactive.has(channelId) && channels.get(channelId) === replacement)
          channels.delete(channelId);
        return;
      }
      broadcast(channelId, state);
    } catch {
      if (channels.get(channelId) === replacement) channels.delete(channelId);
    }
  }
  /** Map replacement is a hard runtime boundary: no old reservations or paths survive. */
  async function reset(channelId: string) {
    evict(channelId);
    // Fresh joins load/sanitize homes from the new map. No old owner can retain
    // a reservation; a channel deleted during CAS does not poison reset.
  }
  async function occupancy(channelId: string, excludePlayerId?: string) {
    const pending = load(channelId);
    const state = await pending;
    if (!isCurrent(state)) throw Error("Stale channel occupancy");
    const positions = [...state.npcs.values()]
      .map(({ x, y }) => ({ x, y }))
      .concat(
        [...state.players.entries()]
          .filter(([id]) => id !== excludePlayerId)
          .map(([, { x, y }]) => ({ x, y })),
      );
    // Prejoin reads have no room membership to trigger disconnect cleanup.
    if (
      !members(channelId).length &&
      !inactive.has(channelId) &&
      channels.get(channelId) === pending
    )
      channels.delete(channelId);
    return positions;
  }

  const spatial = {
    async isInside(channelId: string, socketId: string) {
      const state = await load(channelId),
        position = validatedPlayers.get(`${channelId}:${socketId}`);
      return (
        isCurrent(state) &&
        !!position &&
        !!state.data.meetingSpace &&
        dependencies.getPlayer(socketId)?.mapId === channelId &&
        insideMeetingSpace(state.data.meetingSpace.bounds, position.x / 32, position.y / 32)
      );
    },
    async layout(channelId: string) {
      const state = await load(channelId);
      if (!isCurrent(state)) throw new Error("stale_channel_layout");
      if (!state.data.meetingSpace) throw new Error("meeting_space_unavailable");
      return {
        spaceId: state.data.meetingSpace.id,
        targets: [
          ...state.data.meetingSpace.seatIds.flatMap((id) => {
            const seat = state.data.seats.find((s) => s.id === id);
            return seat ? [{ x: seat.x, y: seat.y, seatId: id }] : [];
          }),
          ...state.data.meetingSpace.standingPositions.map((p) => ({
            x: p.x,
            y: p.y,
            seatId: null,
          })),
        ],
      };
    },
    /**
     * Reserve a spot to come back to before the meeting gathering takes the employee. An employee bound to someone's
     * call is not handed over — but if the call is owned by **the meeting opener's own socket** (`takeFromSocketId`),
     * release it and take the employee. The opener bringing an employee they called (including auto-report calls) to
     * the meeting goes in the same direction as their intent. An employee someone else holds is never taken.
     *
     * When released, the return spot is **its own seat (home)**. Using the current spot it was pulled to by the call
     * would send it back next to the host after the meeting. The call already released the seat reservation
     * (`releaseActor` in `npc:call`), so the original seat cannot be found from the reservation, and returning
     * home after a call ends is the existing rule anyway.
     */
    async capture(channelId: string, actorId: string, takeFromSocketId?: string) {
      const state = await load(channelId),
        npc = state.npcs.get(actorId);
      if (!isCurrent(state)) return null;
      if (!npc) return null;
      if (npc.ownerSocketId && !npc.spatialTarget && npc.phase !== "ambient") {
        if (!takeFromSocketId || npc.ownerSocketId !== takeFromSocketId) return null;
        // Release my call. Without an owner, the following meeting walk (`move`) is not blocked by the ownership check.
        // If it is away from its seat, leave it `ambient` — even if no meeting seat is found, the stroll rule takes it home.
        npc.ownerSocketId = null;
        npc.phase = distance(npc, { x: npc.homeX, y: npc.homeY }) <= 2 ? "idle" : "ambient";
        npc.moving = false;
        npc.continuation = null;
        changed(state, npc);
        broadcast(channelId, state);
        return {
          x: npc.homeX,
          y: npc.homeY,
          seatId:
            state.data.seats.find((s) => distance(s, { x: npc.homeX, y: npc.homeY }) <= 2)?.id ??
            null,
        };
      }
      const seat = [...state.reservations.values()].find((s) => s.actorId === actorId && s.arrived);
      return {
        x: npc.x,
        y: npc.y,
        seatId: seat?.seatId ?? state.data.seats.find((s) => distance(s, npc) <= 2)?.id ?? null,
      };
    },
    async reserve(channelId: string, actorId: string, target: MeetingSpatialTarget) {
      const state = await load(channelId);
      if (!isCurrent(state)) return false;
      prune(state);
      if (target.seatId && !state.data.seats.some((s) => s.id === target.seatId)) return false;
      if (
        !validPoint(state, target.x, target.y) ||
        (state.data.canStandAt && !state.data.canStandAt(target))
      )
        return false;
      if (
        [...state.reservations.values()].some(
          (s) => s.actorId !== actorId && distance(s, target) < 20,
        ) ||
        [...state.npcs.values()].some((n) => n.npcId !== actorId && distance(n, target) < 20) ||
        [...state.players].some(([id, p]) => id !== actorId && distance(p, target) < 20)
      )
        return false;
      const owner =
        state.npcs.get(actorId)?.ownerSocketId ??
        (state.players.has(actorId) ? actorId : leader(channelId));
      if (!owner) return false;
      releaseActor(state, actorId);
      const position = state.npcs.get(actorId) ?? state.players.get(actorId);
      const seatId = target.seatId ?? `standing:${target.x}:${target.y}`;
      state.reservations.set(seatId, {
        seatId,
        actorId,
        ownerSocketId: owner,
        x: target.x,
        y: target.y,
        arrived: !!position && distance(position, target) <= 8,
        expires: Infinity,
        spatial: true,
      });
      changed(state);
      broadcast(channelId, state);
      return true;
    },
    async move(
      channelId: string,
      actorId: string,
      generation: number,
      target: MeetingSpatialTarget,
      returning: boolean,
    ) {
      const state = await load(channelId),
        npc = state.npcs.get(actorId);
      const owner = leader(channelId);
      if (!isCurrent(state)) return false;
      if (!npc || (npc.ownerSocketId && !npc.spatialTarget && npc.phase !== "ambient"))
        return false;
      if (!owner) {
        // There is no browser at all to drive it (a meeting ended by automation/cron, or after the last user left).
        // Previously this returned false, the return died with `return_unavailable`, and the NPC stayed
        // in the meeting seat. Nobody is there to watch the walk, so settle only the outcome.
        npc.spatialTarget = { ...target, generation, returning };
        settleSpatial(state, npc, channelId, target);
        broadcast(channelId, state);
        return true;
      }
      npc.ownerSocketId = owner;
      npc.phase = "called";
      npc.moving = true;
      npc.continuation = null;
      npc.spatialTarget = { ...target, generation, returning };
      spatialLastMotion.set(`${channelId}:${actorId}`, now());
      spatialMotionCredit.set(`${channelId}:${actorId}`, 8);
      for (const r of state.reservations.values())
        if (r.actorId === actorId) r.ownerSocketId = owner;
      changed(state, npc);
      broadcast(channelId, state);
      return true;
    },
    async release(channelId: string, actorId: string) {
      const state = await load(channelId);
      if (!isCurrent(state)) return;
      releaseActor(state, actorId);
      changed(state);
      broadcast(channelId, state);
    },
    async atReservation(channelId: string, socketId: string) {
      const state = await load(channelId);
      if (!isCurrent(state)) return false;
      const position = state.players.get(socketId);
      const reservation = [...state.reservations.values()].find(
        (r) => r.actorId === socketId && r.spatial,
      );
      return !!position && !!reservation && atReservationPoint(reservation, position);
    },
    async returnTarget(channelId: string, actorId: string, origin: MeetingSpatialTarget) {
      const state = await load(channelId);
      if (!isCurrent(state)) return null;
      const npc = state.npcs.get(actorId);
      const reachable = (p: { x: number; y: number }) =>
        !state.data.isWalkable ||
        (!!npc &&
          !!findPath(
            Math.floor(npc.x / 32),
            Math.floor(npc.y / 32),
            Math.floor(p.x / 32),
            Math.floor(p.y / 32),
            state.data.isWalkable,
            (a, b) => clearSegment(a, b, state.data.isWalkable!),
          ));
      const available = (p: { x: number; y: number }) =>
        (!state.data.canStandAt || state.data.canStandAt(p)) &&
        [...state.npcs.values()].every((n) => n.npcId === actorId || distance(n, p) >= 20) &&
        [...state.players.values()].every((n) => distance(n, p) >= 20) &&
        [...state.reservations.values()].every(
          (n) => n.actorId === actorId || distance(n, p) >= 20,
        );
      if (
        available(origin) &&
        reachable(origin) &&
        (!origin.seatId || state.data.seats.some((s) => s.id === origin.seatId))
      )
        return origin;
      let best: MeetingSpatialTarget | null = null,
        bestDistance = Infinity;
      for (let y = 16; y < (state.data.bounds?.height ?? 0); y += 32)
        for (let x = 16; x < (state.data.bounds?.width ?? 0); x += 32) {
          const p = { x, y };
          const d = distance(p, origin);
          if (d < bestDistance && available(p) && reachable(p)) {
            best = { ...p, seatId: null };
            bestDistance = d;
          }
        }
      return best;
    },
  };
  /** A standing spot next to the caller. The first standable of the four neighbor cells, else that person's spot. */
  const besidePlayer = (state: Channel, player: { x: number; y: number }) => {
    const { width = Infinity, height = Infinity } = state.data.bounds ?? {};
    for (const [dx, dy] of [
      [32, 0],
      [-32, 0],
      [0, 32],
      [0, -32],
    ]) {
      const p = { x: player.x + dx, y: player.y + dy };
      if (p.x < 0 || p.y < 0 || p.x >= width || p.y >= height) continue;
      if (state.data.canStandAt && !state.data.canStandAt(p)) continue;
      return p;
    }
    return { x: player.x, y: player.y };
  };
  /**
   * Confirms a stalled owned move as arrived. When the tab comes back, the view teleports to follow the snapshot.
   *
   * - Meeting move: if heading in, finish with the same result as `npc:arrived` (seat arrival·`waiting`); if heading
   *   back, finish with the same settlement as a driverless return and advance the meeting session.
   * - Call: stand it next to the caller and set `waiting`. Ownership stays, so reports and conversation continue.
   */
  const settleStalled = (state: Channel, npc: NpcMotion, channelId: string) => {
    const target = npc.spatialTarget;
    if (target?.returning) {
      settleSpatial(state, npc, channelId, target);
      broadcast(channelId, state);
      return;
    }
    if (target) {
      npc.x = target.x;
      npc.y = target.y;
      npc.moving = false;
      npc.phase = "waiting";
      npc.continuation = null;
      for (const reservation of state.reservations.values())
        if (reservation.actorId === npc.npcId) {
          reservation.x = target.x;
          reservation.y = target.y;
          reservation.arrived = true;
        }
      changed(state, npc);
      broadcast(channelId, state);
      dependencies.onSpatialArrival?.(channelId, npc.npcId, target.generation);
      return;
    }
    const caller = npc.ownerSocketId ? dependencies.getPlayer(npc.ownerSocketId) : undefined;
    if (typeof caller?.x === "number" && typeof caller.y === "number") {
      const at = besidePlayer(state, { x: caller.x, y: caller.y });
      npc.x = at.x;
      npc.y = at.y;
    }
    npc.moving = false;
    npc.phase = "waiting";
    npc.continuation = null;
    changed(state, npc);
    broadcast(channelId, state);
    io.to(channelId).emit("npc:position-sync", {
      npcId: npc.npcId,
      x: npc.x,
      y: npc.y,
      direction: npc.direction,
    });
    io.to(channelId).emit("npc:stop-moving", { npcId: npc.npcId });
  };
  async function sweepStalled() {
    for (const pending of [...channels.values()]) {
      const state = await pending.catch(() => null);
      if (!state || !isCurrent(state)) continue;
      for (const npc of state.npcs.values()) {
        if (!npc.moving || !npc.ownerSocketId) continue;
        if (npc.phase !== "called" && !npc.spatialTarget) continue;
        const last = motionAt.get(`${state.channelId}:${npc.npcId}`) ?? now();
        if (now() - last < STALLED_MOTION_MS) continue;
        settleStalled(state, npc, state.channelId);
      }
    }
  }
  const sweepTimer = setInterval(() => {
    void sweepStalled().catch((error) => console.error("[npc-coordination] stall sweep", error));
  }, STALL_SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
  return { register, joined, moved, left, invalidate, reset, occupancy, spatial, sweepStalled };
}
