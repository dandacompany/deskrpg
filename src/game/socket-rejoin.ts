/**
 * socket.io gets a **new socket.id** on reconnect. The server's `players` map is filled only with the old id,
 * so without sending `player:join` again, subsequent chat:send and player:move are silently dropped at the
 * server's first line (`players.get(socket.id)`) — while the header stays green at "AI 연결".
 *
 * No rejoin on the first connect: the spawn path (`OfficeSimulation.joinMultiplayer`) already sent it,
 * and sending twice delivers `player:joined` twice to other clients.
 */
/**
 * `setupSocketListeners()` is called twice in the normal flow — first from boot's `request-socket` →
 * `socket-ready`, and second when `createPlayer()`'s `player-spawned` → `ThreeGame.tsx` re-emits
 * `socket-ready` with the same socket. Simply stacking `on` while the simulation is alive attaches a handler twice
 * to the same event, and one rejoin sends `player:join` twice.
 *
 * Instead of skipping the whole scene with an "already set up" flag, registration itself is made idempotent — the second
 * `socket-ready` may actually carry a new socket (via a page-level reconnect), so skipping the whole
 * method would create a different bug where no listeners are attached to that new socket at all.
 */
export function registerOnce<E extends string>(
  bus: { on(event: E, handler: () => void): unknown; off(event: E, handler: () => void): unknown },
  event: E,
  handler: () => void,
): void {
  bus.off(event, handler);
  bus.on(event, handler);
}

/**
 * The `EventBus "socket-rejoin"` path (emitted by Task 3 when it receives `chat:error not_joined`) races
 * with the `connect` tracker: the real order is disconnect → the user sends chat (socket.io
 * buffers it) → reconnect: socket.io-client flushes the buffered `chat:send` **before the user's `connect`
 * listener** → the server answers with `chat:error not_joined` → only then does the connect
 * handler join (#1) → the late chat:error handler joins again (#2). Twice on the same socket.
 *
 * All we need is "have we already joined with this socket id" — with the same id #1 already handled it, so skip;
 * with a different id (or none yet, i.e. disconnected) this join has not gone out yet, so
 * send it. When `currentSocketId` is undefined (the moment of disconnection) it is also treated as "not yet
 * joined with this id" and sent — socket.io buffers it and sends it on reconnect.
 */
export function shouldRejoinForError(
  currentSocketId: string | undefined,
  joinedSocketId: string | undefined,
): boolean {
  if (currentSocketId === undefined || joinedSocketId === undefined) return true;
  return currentSocketId !== joinedSocketId;
}

export function createRejoinTracker() {
  let disconnected = false;
  return {
    onDisconnect() {
      disconnected = true;
    },
    shouldRejoin(playerReady: boolean): boolean {
      if (!disconnected || !playerReady) return false;
      disconnected = false;
      return true;
    },
  };
}
