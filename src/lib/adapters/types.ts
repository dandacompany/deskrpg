// src/lib/adapters/types.ts
// NPC Adapter abstraction layer — all agent backends implement this interface.

export interface AdapterExecuteOptions {
  sessionKey: string;
  prompt: string;
  /** Multi-party transcript owned by the caller (ConversationEngine). */
  conversationHistory?: Array<{ role: string; content: string }>;
  onDelta?: (chunk: string) => void;
  onToolProgress?: (toolName: string, preview: string) => void;
  /** Fires as soon as the backend assigns a run handle, for abort/steer. */
  onRunStarted?: (runId: string) => void;
  attachments?: AdapterAttachment[];
  model?: string;
  locale?: string;
  timeoutMs?: number;
  userId?: string;
  projectId?: string;
}

export interface AdapterAttachment {
  type: "image" | "document" | "text";
  mimeType: string;
  fileName: string;
  content: string;
}

export interface AdapterSessionInfo {
  sessionRef: string;
  displayId?: string;
}

export interface AdapterHealthResult {
  status: "ok" | "error" | "not_installed";
  message?: string;
  version?: string;
  model?: string;
}

export interface AdapterConfigField {
  key: string;
  label: string;
  type: "text" | "select" | "toggle" | "number" | "textarea";
  options?: Array<{ value: string; label: string }>;
  default?: unknown;
  hint?: string;
  required?: boolean;
}

export interface AdapterConfigSchema {
  fields: AdapterConfigField[];
}

export interface NpcAdapter {
  readonly type: string;

  execute(options: AdapterExecuteOptions): Promise<{
    response: string;
    session: AdapterSessionInfo;
  }>;

  abort?(sessionKey: string): Promise<void>;
  steer?(text: string): Promise<void>;

  getSessionSummary?(sessionKey: string): Promise<string>;
  resetSession?(sessionKey: string): Promise<void>;

  testConnection(config: Record<string, unknown>): Promise<AdapterHealthResult>;

  getConfigSchema?(): AdapterConfigSchema;
}

export class AdapterRegistry {
  private adapters = new Map<string, NpcAdapter>();

  register(adapter: NpcAdapter): void {
    this.adapters.set(adapter.type, adapter);
  }

  get(type: string): NpcAdapter {
    const adapter = this.adapters.get(type);
    if (!adapter) throw new Error(`Unknown adapter type: ${type}`);
    return adapter;
  }

  has(type: string): boolean {
    return this.adapters.has(type);
  }

  listInstalled(): string[] {
    return [...this.adapters.keys()];
  }
}
