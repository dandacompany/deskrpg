/**
 * The fake plugin server's 0.18.0 approval-policy routes — **test only**. Mimics the paths,
 * status codes, error codes and response fields DeskRPG depends on. No authorization (the
 * plugin only checks the profile key).
 */
import type { ApprovalPolicy } from "./plugin-client-types";

export type FakeApprovalPolicyState = {
  policy: ApprovalPolicy;
  /** The last received `X-DeskRPG-Actor` of a write. */
  lastActor: string | null;
};

type Req = {
  method: string;
  pathname: string;
  json: unknown;
  headers: Record<string, string | undefined>;
};
type Reply = { status: number; body: unknown };

const err = (status: number, error: string, detail?: string): Reply => ({
  status,
  body: { error, ...(detail ? { detail } : {}) },
});

export function createFakeApprovalPolicyState(): FakeApprovalPolicyState {
  return {
    policy: {
      cronMode: "deny",
      singleQueryMode: "deny",
      allowlist: [],
      timeoutSeconds: 300,
      workerPropagation: true,
    },
    lastActor: null,
  };
}

const MODES = new Set(["deny", "approve"]);
const validEntry = (v: unknown): v is string =>
  typeof v === "string" && v.length >= 1 && v.length <= 200 && !/[\r\n\p{Cc}]/u.test(v);

export function routeApprovalPolicy(state: FakeApprovalPolicyState, req: Req): Reply | null {
  const m = req.pathname.match(/^\/deskrpg\/approval-policy(\/allowlist)?$/);
  if (!m) return null;
  const body = (req.json ?? {}) as Record<string, unknown>;
  if (req.method !== "GET") state.lastActor = req.headers["x-deskrpg-actor"] ?? null;
  const ok = (): Reply => ({ status: 200, body: state.policy });

  if (!m[1]) {
    if (req.method === "GET") return ok();
    if (req.method === "PUT") {
      for (const key of ["cronMode", "singleQueryMode"] as const) {
        if (body[key] !== undefined && !MODES.has(String(body[key])))
          return err(400, "invalid_field", key);
      }
      state.policy = {
        ...state.policy,
        ...(body.cronMode ? { cronMode: body.cronMode as ApprovalPolicy["cronMode"] } : {}),
        ...(body.singleQueryMode
          ? { singleQueryMode: body.singleQueryMode as ApprovalPolicy["singleQueryMode"] }
          : {}),
      };
      return ok();
    }
    return err(405, "method_not_allowed");
  }

  if (!validEntry(body.entry)) return err(400, "invalid_allowlist_entry");
  const entry = body.entry;
  if (req.method === "POST") {
    if (!state.policy.allowlist.includes(entry))
      state.policy = { ...state.policy, allowlist: [...state.policy.allowlist, entry] };
    return ok();
  }
  if (req.method === "DELETE") {
    state.policy = {
      ...state.policy,
      allowlist: state.policy.allowlist.filter((e) => e !== entry),
    };
    return ok();
  }
  return err(405, "method_not_allowed");
}
