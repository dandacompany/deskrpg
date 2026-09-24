import { AsyncLocalStorage } from "node:async_hooks";

type Lease = { channelId: string; active: boolean };
type ChannelQueue = {
  tails: Map<string, Promise<void>>;
  context: AsyncLocalStorage<Lease>;
};
const KEY = "__deskrpg_channel_automation_queue__";
const shared = globalThis as typeof globalThis & { [KEY]?: ChannelQueue };
const queue = (shared[KEY] ??= {
  tails: new Map(),
  context: new AsyncLocalStorage<Lease>(),
});

/** Shared by the Next bundle and the socket server. Preserves per-channel execution order within a single server process. */
export async function withChannelAutomationLock<T>(
  channelId: string,
  run: () => Promise<T>,
): Promise<T> {
  const current = queue.context.getStore();
  if (current?.active && current.channelId === channelId) return run();
  const previous = queue.tails.get(channelId) ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  queue.tails.set(channelId, tail);
  await previous;
  const lease: Lease = { channelId, active: true };
  try {
    return await queue.context.run(lease, run);
  } finally {
    // Even if a fire-and-forget child inherited this context, it can't re-enter after release.
    lease.active = false;
    release();
    if (queue.tails.get(channelId) === tail) queue.tails.delete(channelId);
  }
}
