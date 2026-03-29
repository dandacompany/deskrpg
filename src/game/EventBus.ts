// Simple EventEmitter that works in both browser and SSR
// Avoids importing Phaser (which requires `window`) at module level

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Listener = (...args: any[]) => void;

class SimpleEventEmitter {
  private listeners = new Map<string, Set<Listener>>();

  on(event: string, fn: Listener): this {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(fn);
    return this;
  }

  off(event: string, fn: Listener): this {
    this.listeners.get(event)?.delete(fn);
    return this;
  }

  emit(event: string, ...args: unknown[]): this {
    this.listeners.get(event)?.forEach((fn) => fn(...args));
    return this;
  }

  removeListener(event: string, fn?: Listener): this {
    if (fn) {
      this.listeners.get(event)?.delete(fn);
    } else {
      this.listeners.delete(event);
    }
    return this;
  }

  removeAllListeners(event?: string): this {
    if (event) {
      this.listeners.delete(event);
    } else {
      this.listeners.clear();
    }
    return this;
  }
}

export const EventBus = new SimpleEventEmitter();

// Pending channel data — set before GameScene creates, read during create()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export let pendingChannelData: {
  channelId: string;
  mapData: any;
  tiledJson?: any;
  mapConfig?: any;
  savedPosition?: { x: number; y: number } | null;
} | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function setPendingChannelData(data: {
  channelId: string;
  mapData: any;
  tiledJson?: any;
  mapConfig?: any;
  savedPosition?: { x: number; y: number } | null;
} | null) {
  pendingChannelData = data;
}
