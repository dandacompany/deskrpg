import type { MeetingSpatialState, MeetingSpatialTarget } from "../lib/meeting-discussion-state";

type Target = MeetingSpatialTarget;
/** Within this many px of a meeting spot counts as already standing on it (half a tile). */
const HERE = 16;
type Dependencies = {
  timeoutMs?: number;
  layout(channelId: string): Promise<{ spaceId: string; targets: Target[] }>;
  /**
   * Reserves the seat to return to. `takeFromSocketId` is the socket of whoever opens the meeting — employees
   * summoned by that socket are released and brought along. Employees summoned by others get null (as now,
   * `actor_unavailable`).
   */
  capture(channelId: string, actorId: string, takeFromSocketId?: string): Promise<Target | null>;
  reserve(channelId: string, actorId: string, target: Target): Promise<boolean>;
  move(
    channelId: string,
    actorId: string,
    generation: number,
    target: Target,
    returning: boolean,
  ): Promise<boolean>;
  release(channelId: string, actorId: string): Promise<void>;
  /**
   * Whether that socket is in its own reserved seat **right now**. Must be the same judgment the movement handler
   * uses to report arrival. A person's arrival notice only comes from movement, so if they're already seated there
   * at reservation time, this is what detects it.
   */
  atReservation?(channelId: string, socketId: string): Promise<boolean>;
  /** Where that socket's avatar stands now, if known. A person already on a meeting spot keeps that spot. */
  position?(channelId: string, socketId: string): Promise<{ x: number; y: number } | null>;
  returnTarget(channelId: string, actorId: string, origin: Target): Promise<Target | null>;
  publish(state: MeetingSpatialState): void;
};
type Session = {
  state: MeetingSpatialState;
  ownerId: string;
  origins: Map<string, Target>;
  ready: Promise<boolean>;
  resolve: (ready: boolean) => void;
  timer?: ReturnType<typeof setTimeout>;
  cancelRequested?: boolean;
};

/** Manages only the meeting space state. Actual seats and movement ownership are delegated to the existing motion
 * source of truth. */
export function createMeetingSpatialCoordinator(deps: Dependencies) {
  const sessions = new Map<string, Session>();
  const playerSockets = new Map<string, string>();
  /**
   * Other sockets of the same person that joined the meeting while `playerSockets` stayed bound elsewhere — a second
   * tab, or a reconnect the server has not noticed as a disconnect yet. One of them takes over when the bound socket
   * leaves, so that socket leaving does not end the person's participation.
   */
  const standby = new Map<string, Set<string>>();
  const operations = new Map<string, Promise<unknown>>();
  const epochs = new Map<string, number>();
  const waitingSockets = (key: string) => {
    let set = standby.get(key);
    if (!set) standby.set(key, (set = new Set()));
    return set;
  };
  const generations = new Map<string, number>();
  const nextGeneration = (channelId: string) => {
    const value = (generations.get(channelId) ?? 0) + 1;
    generations.set(channelId, value);
    return value;
  };
  const enqueue = <T>(channelId: string, operation: () => Promise<T>, stale: T): Promise<T> => {
    const epoch = epochs.get(channelId) ?? 0;
    const pending = (operations.get(channelId) ?? Promise.resolve())
      .catch(() => {})
      .then(() => ((epochs.get(channelId) ?? 0) === epoch ? operation() : stale));
    operations.set(channelId, pending);
    void pending
      .finally(() => {
        if (operations.get(channelId) === pending) operations.delete(channelId);
      })
      .catch(() => {});
    return pending;
  };
  const publish = (s: Session) => {
    if (sessions.get(s.state.channelId) === s) deps.publish(structuredClone(s.state));
  };
  const settle = (s: Session, ready: boolean) => {
    clearTimeout(s.timer);
    s.resolve(ready);
  };
  /** Ready once nobody is still walking. Arrival notices do this too, but a gathering whose last NPC was demoted in
   * place gets no arrival notice. */
  function settleIfGathered(s: Session) {
    if (
      s.state.phase === "assembling" &&
      s.state.participants.every((p) => p.state === "seated" || p.state === "standing")
    ) {
      s.state.phase = "ready";
      settle(s, true);
    }
  }
  /** Attend from where it stands: no spot and nothing to walk to. A full room must not stop the meeting. */
  function standInPlace(p: MeetingSpatialState["participants"][number]) {
    p.state = "standing";
    p.seatId = null;
    p.target = null;
  }
  function block(channelId: string, actorId: string, reasonCode: string, generation?: number) {
    const s = sessions.get(channelId);
    if (!s || (generation !== undefined && s.state.generation !== generation)) return;
    const p = s.state.participants.find((p) => p.actorId === actorId);
    if (p) p.state = "blocked";
    s.state.phase = "blocked";
    s.state.failure = { actorId, reasonCode };
    settle(s, false);
    publish(s);
  }
  async function start(channelId: string, ownerId: string, npcIds: string[]) {
    const previous = sessions.get(channelId);
    if (previous && previous.state.phase !== "idle" && previous.state.phase !== "blocked")
      return null;
    // Correcting the selection of a failed preparation relocates the same participants while keeping the original
    // position record.
    if (
      previous?.state.phase === "blocked" &&
      previous.state.participants.some((p) => p.kind === "npc" && !npcIds.includes(p.actorId))
    ) {
      await cancel(channelId);
      return null;
    }
    let resolve!: (ready: boolean) => void;
    const s: Session = {
      ownerId,
      origins: previous?.origins ?? new Map(),
      ready: new Promise<boolean>((r) => {
        resolve = r;
      }),
      resolve: (v) => resolve(v),
      state: {
        channelId,
        spaceId: previous?.state.spaceId ?? "",
        generation: nextGeneration(channelId),
        phase: "assembling",
        participants: [
          ...(previous?.state.participants.filter((p) => p.kind === "player") ?? []),
          ...[...new Set(npcIds)].map((actorId) => ({
            actorId,
            kind: "npc" as const,
            state: "walking" as const,
            seatId: null,
            target: null,
          })),
        ],
        failure: null,
      },
    };
    sessions.set(channelId, s);
    const generation = s.state.generation;
    publish(s);
    const current = () =>
      sessions.get(channelId) === s &&
      s.state.generation === generation &&
      s.state.phase === "assembling" &&
      !s.cancelRequested;
    try {
      const layout = await deps.layout(channelId);
      if (!current()) return generation;
      s.state.spaceId = layout.spaceId;
      for (const p of s.state.participants.filter(
        (p) => p.kind === "player" && p.state === "blocked",
      )) {
        const socketId = playerSockets.get(`${channelId}:${p.actorId}`);
        if (socketId) await joinPlayer(channelId, p.actorId, socketId);
        if (!current()) return generation;
      }
      for (const actorId of [...new Set(npcIds)]) {
        if (!current()) break;
        const p = s.state.participants.find((p) => p.actorId === actorId && p.kind === "npc")!;
        const origin = await deps.capture(
          channelId,
          actorId,
          playerSockets.get(`${channelId}:${ownerId}`),
        );
        if (!current()) break;
        if (!origin) {
          block(channelId, actorId, "actor_unavailable", generation);
          break;
        }
        if (!s.origins.has(actorId)) s.origins.set(actorId, origin);
        let target: Target | undefined;
        for (const candidate of layout.targets) {
          if (await deps.reserve(channelId, actorId, candidate)) {
            target = candidate;
            break;
          }
          if (!current()) break;
        }
        if (!current()) break;
        if (!target) {
          standInPlace(p);
          continue;
        }
        p.seatId = target.seatId;
        p.target = { x: target.x, y: target.y };
        if (!(await deps.move(channelId, actorId, generation, target, false))) {
          block(channelId, actorId, "movement_unavailable", generation);
          break;
        }
      }
      if (current() && npcIds.length === 0)
        block(channelId, ownerId, "actor_unavailable", generation);
      if (current()) {
        settleIfGathered(s);
        publish(s);
        s.timer = setTimeout(() => {
          const p = s.state.participants.find((p) => p.state === "walking");
          if (p) block(channelId, p.actorId, "arrival_timeout", generation);
        }, deps.timeoutMs ?? 120_000);
        s.timer.unref();
      }
    } catch {
      if (current()) block(channelId, npcIds[0] ?? ownerId, "layout_unavailable", generation);
    }
    return generation;
  }
  async function joinPlayer(channelId: string, userId: string, socketId: string) {
    let s = sessions.get(channelId);
    if (!s) {
      s = {
        ownerId: userId,
        origins: new Map(),
        ready: Promise.resolve(false),
        resolve: () => {},
        state: {
          channelId,
          spaceId: "",
          generation: 0,
          phase: "idle",
          participants: [],
          failure: null,
        },
      };
      sessions.set(channelId, s);
    }
    const key = `${channelId}:${userId}`;
    const current = () => sessions.get(channelId) === s;
    const previousSocket = playerSockets.get(key);
    const existing = s.state.participants.find((p) => p.actorId === userId && p.kind === "player");
    if (previousSocket && previousSocket !== socketId) {
      // A socket that is sitting on its reserved seat keeps it. Another socket of the same person — a background tab
      // rejoining after its connection blinked, or a reconnect while the old socket still looks alive — used to take
      // the participation over, reserve a new seat for an avatar that never walks, and freeze the gathering at
      // "walking" (observed on staging, retries included).
      if (existing?.state === "seated" && (await deps.atReservation?.(channelId, previousSocket))) {
        if (!current()) return false;
        waitingSockets(key).add(socketId);
        return true;
      } else {
        await deps.release(channelId, previousSocket);
        if (!current()) return false;
        waitingSockets(key).add(previousSocket);
      }
    }
    if (!current()) return false;
    standby.get(key)?.delete(socketId);
    playerSockets.set(key, socketId);
    if (existing && previousSocket === socketId && existing.state !== "blocked") return true;
    const p: MeetingSpatialState["participants"][number] = existing ?? {
      actorId: userId,
      kind: "player",
      state: "walking",
      target: null,
      seatId: null,
    };
    if (!existing) s.state.participants.push(p);
    try {
      const layout = await deps.layout(channelId);
      if (!current()) return false;
      s.state.spaceId = layout.spaceId;
      // The spot the person is standing on goes first, so someone already seated is not sent to another seat.
      const at = await deps.position?.(channelId, socketId);
      if (!current()) return false;
      const targets = at
        ? [...layout.targets].sort(
            (a, b) =>
              Number(Math.hypot(a.x - at.x, a.y - at.y) > HERE) -
              Number(Math.hypot(b.x - at.x, b.y - at.y) > HERE),
          )
        : layout.targets;
      for (const target of targets) {
        const reserved = await deps.reserve(channelId, socketId, target);
        if (!current()) return false;
        if (reserved) {
          p.state = "walking";
          p.target = { x: target.x, y: target.y };
          p.seatId = target.seatId;
          publish(s);
          // If already in that seat, handle arrival now. Arrival notices only come from **movement**, so a person
          // sitting still in the seat (including one who re-reserved it via reconnect/retry) would, unless checked
          // here, stay `in transit` forever and the gathering would break on timeout (observed on staging).
          // Generation and cancellation checks are done by `arrived` as usual.
          if (await deps.atReservation?.(channelId, socketId)) {
            if (!current() || playerSockets.get(key) !== socketId) return true;
            arrived(channelId, userId, s.state.generation);
          }
          return true;
        }
      }
      standInPlace(p);
      if (s.state.phase === "assembling") settleIfGathered(s);
      publish(s);
      return true;
    } catch {
      if (current()) block(channelId, userId, "layout_unavailable");
    }
    return false;
  }
  async function leavePlayer(channelId: string, userId: string, socketId: string) {
    const key = `${channelId}:${userId}`;
    const waiting = standby.get(key);
    if (playerSockets.get(key) !== socketId) {
      waiting?.delete(socketId);
      return;
    }
    playerSockets.delete(key);
    const s = sessions.get(channelId);
    await deps.release(channelId, socketId);
    if (!s || sessions.get(channelId) !== s) return;
    const heir = waiting?.values().next().value;
    if (heir) {
      waiting!.delete(heir);
      await joinPlayer(channelId, userId, heir);
      return;
    }
    s.state.participants = s.state.participants.filter(
      (p) => p.kind !== "player" || p.actorId !== userId,
    );
    if (s.state.phase === "assembling") block(channelId, userId, "participant_left");
    else publish(s);
  }
  function arrived(channelId: string, actorId: string, generation: number) {
    const s = sessions.get(channelId);
    if (!s || s.state.generation !== generation || s.cancelRequested) return false;
    const p = s.state.participants.find((p) => p.actorId === actorId);
    if (!p || (p.state !== "walking" && p.state !== "returning")) return false;
    p.state = p.seatId ? "seated" : "standing";
    if (
      s.state.phase === "returning" &&
      s.state.participants.every((p) => p.state !== "returning")
    ) {
      s.state.phase = "idle";
      clearTimeout(s.timer);
      s.state.participants = s.state.participants.filter((p) => p.kind === "player");
      s.origins.clear();
    } else if (
      s.state.phase === "assembling" &&
      s.state.participants.every((p) => p.state === "seated" || p.state === "standing")
    ) {
      s.state.phase = "ready";
      settle(s, true);
    }
    publish(s);
    return true;
  }
  async function cancel(channelId: string) {
    const s = sessions.get(channelId);
    if (!s || s.state.phase === "idle" || s.state.phase === "returning") return;
    settle(s, false);
    s.cancelRequested = false;
    const generation = nextGeneration(channelId);
    s.state.generation = generation;
    const current = () => sessions.get(channelId) === s && s.state.generation === generation;
    s.state.phase = "returning";
    s.state.failure = null;
    // NPCs attending in place were never sent anywhere and hold no reservation — nothing to walk back from.
    const inPlace = (p: MeetingSpatialState["participants"][number]) =>
      p.kind === "npc" && p.state === "standing" && !p.target;
    for (const p of s.state.participants.filter(inPlace)) s.origins.delete(p.actorId);
    s.state.participants = s.state.participants.filter((p) => !inPlace(p));
    const npcs = s.state.participants.filter((p) => p.kind === "npc");
    for (const p of npcs) p.state = "returning";
    publish(s);
    s.timer = setTimeout(() => {
      const p = s.state.participants.find((p) => p.state === "returning");
      if (p) block(channelId, p.actorId, "return_timeout", generation);
    }, deps.timeoutMs ?? 120_000);
    s.timer.unref();
    for (const p of npcs) {
      if (!current()) return;
      const origin = s.origins.get(p.actorId);
      if (!origin) {
        s.state.participants = s.state.participants.filter((other) => other !== p);
        continue;
      }
      await deps.release(channelId, p.actorId);
      if (!current()) return;
      const target = await deps.returnTarget(channelId, p.actorId, origin);
      if (!current()) return;
      const reserved = target && (await deps.reserve(channelId, p.actorId, target));
      if (!current()) return;
      if (!target || !reserved) {
        block(channelId, p.actorId, "return_space_full", generation);
        continue;
      }
      p.seatId = target.seatId;
      p.target = { x: target.x, y: target.y };
      if (!(await deps.move(channelId, p.actorId, generation, target, true)))
        block(channelId, p.actorId, "return_unavailable", generation);
      if (!current()) return;
    }
    if (!s.state.participants.some((p) => p.kind === "npc")) {
      s.state.phase = "idle";
      s.origins.clear();
    }
    publish(s);
  }
  return {
    reset(channelId: string) {
      epochs.set(channelId, (epochs.get(channelId) ?? 0) + 1);
      operations.delete(channelId);
      nextGeneration(channelId);
      const s = sessions.get(channelId);
      if (s) {
        s.cancelRequested = true;
        settle(s, false);
        sessions.delete(channelId);
      }
      for (const key of playerSockets.keys())
        if (key.startsWith(`${channelId}:`)) playerSockets.delete(key);
      for (const key of standby.keys()) if (key.startsWith(`${channelId}:`)) standby.delete(key);
    },
    start: (channelId: string, ownerId: string, npcIds: string[]) =>
      enqueue(channelId, () => start(channelId, ownerId, npcIds), null),
    cancel: (channelId: string) => {
      const s = sessions.get(channelId);
      if (s && s.state.phase !== "returning" && s.state.phase !== "idle") {
        s.cancelRequested = true;
        settle(s, false);
      }
      return enqueue(channelId, () => cancel(channelId), undefined);
    },
    arrived,
    block,
    joinPlayer: (channelId: string, userId: string, socketId: string) =>
      enqueue(channelId, () => joinPlayer(channelId, userId, socketId), false),
    leavePlayer: (channelId: string, userId: string, socketId: string) =>
      enqueue(channelId, () => leavePlayer(channelId, userId, socketId), undefined),
    playerArrived(channelId: string, userId: string, socketId: string) {
      const s = sessions.get(channelId);
      if (s && playerSockets.get(`${channelId}:${userId}`) === socketId)
        arrived(channelId, userId, s.state.generation);
    },
    snapshot: (channelId: string) => {
      const s = sessions.get(channelId);
      return s ? structuredClone(s.state) : null;
    },
    ready: (channelId: string, generation: number) => {
      const s = sessions.get(channelId);
      return s?.state.generation === generation ? s.ready : Promise.resolve(false);
    },
    owner: (channelId: string) => sessions.get(channelId)?.ownerId,
  };
}
export type MeetingSpatialCoordinator = ReturnType<typeof createMeetingSpatialCoordinator>;
