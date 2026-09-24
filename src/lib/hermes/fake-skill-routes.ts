/**
 * The fake plugin server's 0.15.0 skill routes — **test only**. Mimics only the parts of the plugin's behavior that
 * DeskRPG depends on: paths, status codes, error codes, response fields. No authorization (the plugin only looks at
 * the profile key).
 */
import { createHash } from "node:crypto";

export type FakeSkill = {
  name: string;
  source: "local" | "hub" | "bundled";
  files: Map<string, string>;
  pinned: boolean;
  disabled: boolean;
  useCount: number;
};

export type FakeSkillJob = {
  jobId: string;
  kind: string;
  state: string;
  exitCode: number | null;
  outputTail: string;
};

export type FakeSkillState = {
  skills: Map<string, FakeSkill>;
  archived: Map<string, FakeSkill>;
  /** File memory fragments — node id is `memory:memory:<index>`. */
  memory: string[];
  jobs: Map<string, FakeSkillJob>;
  paused: boolean;
  /** The last received `X-DeskRPG-Actor` value. */
  lastActor: string | null;
  seed(
    name: string,
    opts?: { source?: FakeSkill["source"]; files?: Record<string, string>; useCount?: number },
  ): void;
};

type Req = {
  method: string;
  pathname: string;
  params: URLSearchParams;
  json: unknown;
  headers: Record<string, string | undefined>;
};
type Reply = { status: number; body: unknown };

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const err = (status: number, error: string, detail?: string): Reply => ({
  status,
  body: { error, ...(detail ? { detail } : {}) },
});

export function createFakeSkillState(): FakeSkillState {
  const state: FakeSkillState = {
    skills: new Map(),
    archived: new Map(),
    memory: [],
    jobs: new Map(),
    paused: false,
    lastActor: null,
    seed(name, opts = {}) {
      const files = new Map<string, string>([
        ["SKILL.md", `---\nname: ${name}\ndescription: ${name}\n---\n# ${name}\n`],
      ]);
      for (const [k, v] of Object.entries(opts.files ?? {})) files.set(k, v);
      state.skills.set(name, {
        name,
        source: opts.source ?? "local",
        files,
        pinned: false,
        disabled: false,
        useCount: opts.useCount ?? 0,
      });
    },
  };
  return state;
}

const editable = (s: FakeSkill, path: string) =>
  s.source === "local" && (path === "SKILL.md" || /^(references|templates)\//.test(path));

function row(s: FakeSkill) {
  return {
    name: s.name,
    category: "",
    description: s.name,
    disabled: s.disabled,
    essential: false,
    source: s.source,
    curatorManaged: false,
    state: "active",
    pinned: s.pinned,
    useCount: s.useCount,
    viewCount: 0,
    lastUsedAt: null,
  };
}

function startJob(state: FakeSkillState, kind: string): Reply {
  if ([...state.jobs.values()].some((j) => j.state === "running")) return err(409, "job_busy");
  const jobId = `job-${state.jobs.size + 1}`;
  state.jobs.set(jobId, { jobId, kind, state: "succeeded", exitCode: 0, outputTail: "ok" });
  return { status: 202, body: { jobId } };
}

function routeCurator(
  state: FakeSkillState,
  rest: string[],
  req: Req,
  body: Record<string, unknown>,
): Reply {
  const { method } = req;
  if (rest.length === 0 && method === "GET") {
    return {
      status: 200,
      body: {
        enabled: true,
        paused: state.paused,
        intervalHours: 168,
        lastRunAt: null,
        minIdleHours: 2,
        staleAfterDays: 14,
        archiveAfterDays: 30,
      },
    };
  }
  if (rest[0] === "paused" && method === "PUT") {
    state.paused = Boolean(body.paused);
    return { status: 200, body: { paused: state.paused } };
  }
  if (rest[0] === "runs" && rest.length === 1 && method === "POST")
    return startJob(state, "curator_run");
  if (rest[0] === "runs" && rest.length === 2 && method === "GET") {
    const j = state.jobs.get(rest[1]);
    return j ? { status: 200, body: j } : err(404, "job_unknown");
  }
  return err(404, "not_found");
}

function routeLearning(
  state: FakeSkillState,
  rest: string[],
  req: Req,
  body: Record<string, unknown>,
): Reply {
  const { method } = req;
  if (rest[0] === "graph" && method === "GET") {
    const include = req.params.get("includeMemory") === "1";
    const nodes = [...state.skills.values()].map((s) => ({
      id: s.name,
      label: s.name,
      kind: "skill",
      timestamp: 1,
    }));
    const mem = include
      ? state.memory.map((c, i) => ({
          id: `memory:memory:${i}`,
          label: c,
          kind: "memory",
          timestamp: 2,
        }))
      : [];
    return {
      status: 200,
      body: {
        nodes: [...nodes, ...mem],
        edges: [],
        ...(include ? { memory: state.memory } : {}),
        stats: {},
      },
    };
  }
  if (rest[0] !== "node") return err(404, "not_found");
  const id = method === "GET" ? (req.params.get("id") ?? "") : String(body.id ?? "");
  const isMem = id.startsWith("memory:");
  const idx = isMem ? Number(id.split(":")[2]) : -1;
  const content = isMem ? state.memory[idx] : state.skills.get(id)?.files.get("SKILL.md");
  if (content === undefined) return err(404, "node_not_found");
  if (method === "GET") {
    return {
      status: 200,
      body: { id, kind: isMem ? "memory" : "skill", content, hash: sha(content) },
    };
  }
  if (body.baseHash !== sha(content)) return err(409, "node_changed");
  if (method === "PUT") {
    const next = String(body.content);
    if (isMem) state.memory[idx] = next;
    else state.skills.get(id)!.files.set("SKILL.md", next);
    return { status: 200, body: { id, hash: sha(next) } };
  }
  if (method === "DELETE") {
    if (isMem) {
      state.memory.splice(idx, 1);
      return { status: 200, body: { id, kind: "memory", result: "deleted" } };
    }
    const s = state.skills.get(id)!;
    state.skills.delete(id);
    state.archived.set(id, s);
    return { status: 200, body: { id, kind: "skill", result: "archived" } };
  }
  return err(404, "not_found");
}

function routeSkillArea(
  state: FakeSkillState,
  rest: string[],
  req: Req,
  body: Record<string, unknown>,
): Reply {
  const { method } = req;
  if (rest.length === 0) {
    if (method === "GET")
      return { status: 200, body: { skills: [...state.skills.values()].map(row) } };
    if (method === "POST") {
      const name = String(body.name ?? "");
      if (state.skills.has(name)) return err(400, "skill_write_rejected", "exists");
      state.seed(name);
      state.skills.get(name)!.files.set("SKILL.md", String(body.content ?? ""));
      return { status: 201, body: { name } };
    }
    return err(404, "not_found");
  }
  if (rest[0] === "enabled" && rest.length === 1 && method === "PUT") {
    for (const n of (body.enable as string[] | undefined) ?? []) {
      const s = state.skills.get(n);
      if (s) s.disabled = false;
    }
    for (const n of (body.disable as string[] | undefined) ?? []) {
      const s = state.skills.get(n);
      if (s) s.disabled = true;
    }
    const disabled = [...state.skills.values()].filter((s) => s.disabled).map((s) => s.name);
    return { status: 200, body: { disabled } };
  }
  if (rest[0] === "hub") {
    if (rest[1] === "search") {
      return {
        status: 200,
        body: {
          results: [
            {
              identifier: "skills-sh/x/pdf",
              name: "pdf",
              description: "PDF",
              source: "skills-sh",
              trustLevel: "community",
            },
          ],
          timedOut: [],
        },
      };
    }
    if (rest[1] === "preview") {
      return {
        status: 200,
        body: {
          name: "pdf",
          identifier: req.params.get("identifier"),
          description: "PDF",
          source: "skills-sh",
          trustLevel: "community",
          skillMd: "---\nname: pdf\n---\n",
          files: ["SKILL.md"],
          hasScripts: false,
          verdict: "safe",
          policy: "allow",
          policyReason: "",
        },
      };
    }
    if (rest[1] === "installs" && rest.length === 2 && method === "POST")
      return startJob(state, "hub_install");
    if (rest[1] === "installs" && rest.length === 3) {
      const j = state.jobs.get(rest[2]);
      return j ? { status: 200, body: j } : err(404, "job_unknown");
    }
    if ((rest[1] === "uninstall" || rest[1] === "update") && method === "POST") {
      return startJob(state, "hub_update");
    }
    return err(404, "not_found");
  }
  if (rest[0] === "archive") {
    if (rest.length === 1 && method === "GET") {
      const archived = [...state.archived.keys()].map((name) => ({
        name,
        archivedAt: "2026-09-24T00:00:00+00:00",
      }));
      return { status: 200, body: { archived } };
    }
    const s = state.archived.get(rest[1]);
    if (!s) return err(404, "archived_not_found");
    if (rest[2] === "restore" && method === "POST") {
      state.archived.delete(s.name);
      state.skills.set(s.name, s);
      return { status: 200, body: { name: s.name } };
    }
    if (rest.length === 2 && method === "DELETE") {
      state.archived.delete(s.name);
      return { status: 200, body: { name: s.name, ledgerId: "e1" } };
    }
    return err(404, "not_found");
  }

  const s = state.skills.get(rest[0]);
  if (!s) return err(404, "skill_not_found");
  const sub = rest[1];
  if (sub === undefined && method === "GET") {
    return {
      status: 200,
      body: {
        skill: {
          name: s.name,
          source: s.source,
          curatorManaged: false,
          pinned: s.pinned,
          frontmatter: { name: s.name },
        },
        files: [...s.files.entries()].map(([path, c]) => ({
          path,
          size: c.length,
          editable: editable(s, path),
        })),
      },
    };
  }
  if (sub === "file") {
    const path = method === "GET" ? (req.params.get("path") ?? "") : String(body.path ?? "");
    if (method === "GET") {
      const c = s.files.get(path);
      return c === undefined
        ? err(404, "file_not_found")
        : { status: 200, body: { path, content: c, hash: sha(c) } };
    }
    if (method !== "PUT") return err(404, "not_found");
    if (!editable(s, path)) return err(403, "path_not_editable");
    const cur = s.files.get(path);
    // A new file has baseHash null — conflict if it already exists. An existing file must match the current hash.
    if (body.baseHash === null) {
      if (cur !== undefined) return err(409, "file_exists");
    } else if (cur === undefined || sha(cur) !== body.baseHash) {
      return err(409, "skill_changed");
    }
    const next = String(body.content);
    s.files.set(path, next);
    return { status: 200, body: { path, hash: sha(next) } };
  }
  if (sub === "enabled" && method === "PUT") {
    s.disabled = !body.enabled;
    return { status: 200, body: { name: s.name, enabled: !s.disabled } };
  }
  if (sub === "pinned" && method === "PUT") {
    if (s.source !== "local") return err(400, "skill_not_local");
    s.pinned = Boolean(body.pinned);
    return { status: 200, body: { name: s.name, pinned: s.pinned } };
  }
  if (sub === "archive" && method === "POST") {
    if (s.source !== "local") return err(400, "skill_not_local");
    state.skills.delete(s.name);
    state.archived.set(s.name, s);
    return { status: 200, body: { name: s.name } };
  }
  return err(404, "not_found");
}

/**
 * null unless `/deskrpg/skills…`·`/deskrpg/curator…`·`/deskrpg/learning…` — the caller continues its original
 * routing.
 */
export function routeSkills(state: FakeSkillState, req: Req): Reply | null {
  const m = /^\/deskrpg\/(skills|curator|learning)(\/.*)?$/.exec(req.pathname);
  if (!m) return null;
  const actor = req.headers["x-deskrpg-actor"];
  if (actor) state.lastActor = actor;
  const [, area, restRaw] = m;
  const rest = (restRaw ?? "").split("/").filter(Boolean).map(decodeURIComponent);
  const body = (req.json ?? {}) as Record<string, unknown>;
  if (area === "curator") return routeCurator(state, rest, req, body);
  if (area === "learning") return routeLearning(state, rest, req, body);
  return routeSkillArea(state, rest, req, body);
}
