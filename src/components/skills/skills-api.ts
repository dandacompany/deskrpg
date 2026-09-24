/**
 * Browser-side calls to the NPC skills REST API (`/api/channels/:id/npcs/:npcId/skills/**`).
 * Failures are thrown as-is as `SkillsApiError` from the server's `{code, message, …}` —
 * translation is the UI's job.
 */
import type {
  ArchivedSkill,
  CuratorStatus,
  HubPreview,
  HubSearchResult,
  LearningGraph,
  LearningNodeDetail,
  SkillDetail,
  SkillFile,
  SkillJob,
  SkillRow,
} from "@/lib/hermes/plugin-client-types";

export class SkillsApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly minVersion?: string;
  constructor(status: number, code: string, message: string, minVersion?: string) {
    super(message);
    this.name = "SkillsApiError";
    this.status = status;
    this.code = code;
    this.minVersion = minVersion;
  }
}

export type SkillListView = {
  skills: SkillRow[];
  canManage: boolean;
  capabilityReady: boolean;
  sharedChannelCount: number;
};

async function fail(res: Response): Promise<SkillsApiError> {
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await res.json();
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    /* no body */
  }
  return new SkillsApiError(
    res.status,
    typeof body.code === "string" ? body.code : "http_error",
    typeof body.message === "string" ? body.message : "",
    typeof body.minVersion === "string" ? body.minVersion : undefined,
  );
}

export function createSkillsApi(channelId: string, npcId: string, fetchImpl: typeof fetch = fetch) {
  const root = `/api/channels/${encodeURIComponent(channelId)}/npcs/${encodeURIComponent(npcId)}/skills`;
  const seg = (s: string) => encodeURIComponent(s);
  async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetchImpl(`${root}/${path}`, {
      method,
      ...(body !== undefined
        ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
        : {}),
    });
    if (!res.ok) throw await fail(res);
    return (await res.json()) as T;
  }
  const qs = (o: Record<string, string>) => `?${new URLSearchParams(o).toString()}`;
  return {
    list: () => req<SkillListView>("GET", ""),
    detail: (name: string) => req<SkillDetail>("GET", seg(name)),
    readFile: (name: string, path: string) =>
      req<SkillFile>("GET", `${seg(name)}/file${qs({ path })}`),
    writeFile: (name: string, path: string, content: string, baseHash: string | null) =>
      req<{ path: string; hash: string }>("PUT", `${seg(name)}/file`, { path, content, baseHash }),
    create: (name: string, category: string | undefined, content: string) =>
      req<{ name: string }>("POST", "", { name, category, content }),
    setEnabled: async (name: string, enabled: boolean) => {
      await req("PUT", `${seg(name)}/enabled`, { enabled });
    },
    setEnabledBulk: (enable: string[], disable: string[]) =>
      req<{ disabled: string[] }>("PUT", "enabled", { enable, disable }),
    setPinned: async (name: string, pinned: boolean) => {
      await req("PUT", `${seg(name)}/pinned`, { pinned });
    },
    archive: async (name: string) => {
      await req("POST", `${seg(name)}/archive`, {});
    },
    listArchived: async () => (await req<{ archived: ArchivedSkill[] }>("GET", "archive")).archived,
    restore: async (name: string) => {
      await req("POST", `archive/${seg(name)}/restore`, {});
    },
    purge: async (name: string) => {
      await req("DELETE", `archive/${seg(name)}`);
    },
    hubSearch: async (q: string) =>
      (await req<{ results: HubSearchResult[] }>("GET", `hub/search${qs({ q })}`)).results,
    hubPreview: (identifier: string) => req<HubPreview>("GET", `hub/preview${qs({ identifier })}`),
    hubInstall: async (identifier: string, force: boolean) =>
      (await req<{ jobId: string }>("POST", "hub/installs", { identifier, force })).jobId,
    hubUninstall: async (name: string) =>
      (await req<{ jobId: string }>("POST", "hub/uninstall", { name })).jobId,
    hubUpdate: async (name: string | null) =>
      (await req<{ jobId: string }>("POST", "hub/update", name ? { name } : {})).jobId,
    job: (kind: "hub" | "curator", jobId: string) =>
      req<SkillJob>(
        "GET",
        kind === "hub" ? `hub/installs/${seg(jobId)}` : `curator/runs/${seg(jobId)}`,
      ),
    curator: () => req<CuratorStatus>("GET", "curator"),
    setCuratorPaused: async (paused: boolean) => {
      await req("PUT", "curator/paused", { paused });
    },
    runCurator: async () => (await req<{ jobId: string }>("POST", "curator/runs", {})).jobId,
    graph: () => req<LearningGraph>("GET", "learning/graph"),
    node: (id: string) => req<LearningNodeDetail>("GET", `learning/node${qs({ id })}`),
    putNode: async (id: string, content: string, baseHash: string) => {
      await req("PUT", "learning/node", { id, content, baseHash });
    },
    deleteNode: async (id: string, baseHash: string) => {
      await req("DELETE", "learning/node", { id, baseHash });
    },
  };
}

export type SkillsApi = ReturnType<typeof createSkillsApi>;
