import { NextRequest, NextResponse } from "next/server";
import { getUserId } from "@/lib/internal-rpc";
import {
  sameOriginMutation,
  safeSetupError,
  validateProfileDescription,
  validateProfileName,
  validateSetupPort,
  validateTimezone,
} from "@/lib/hermes/setup/policy";
import {
  setupCapabilities,
  discoverSetupHost,
  inspectSetupHost,
  checkSetupModel,
  startSetup,
  getSetupJob,
  cancelSetupJob,
  connectSetupUrl,
  sshPublicKey,
  sshScanHost,
  sshRegisterHost,
  sshRemoveHost,
  sshSystemAdd,
  sshSystemInfo,
} from "@/lib/hermes/setup/service";
import type { HostTarget, SetupProvisionRequest } from "@/lib/hermes/setup/types";
import { SetupPortConflictError } from "@/lib/hermes/setup/host";
import { isValidProfileName } from "@/lib/hermes/profile-name";

export const runtime = "nodejs";
async function readBody(req: NextRequest) {
  const reader = req.body?.getReader();
  if (!reader) throw new Error("setup_invalid_request");
  const decoder = new TextDecoder();
  let size = 0,
    text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16384) throw new Error("setup_invalid_request");
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    await reader.cancel().catch(() => {});
  }
}
const response = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
function failure(error: unknown) {
  const code = safeSetupError(error);
  const status =
    code === "setup_forbidden" ||
    code === "setup_bad_origin" ||
    code === "hermes_install_forbidden" ||
    code === "profile_provision_forbidden"
      ? 403
      : code === "setup_not_found"
        ? 404
        : code === "setup_busy" ||
            code === "profile_exists" ||
            code === "resume_unavailable" ||
            code === "port_write_failed"
          ? 409
          : 400;
  // Only conflicts get one extra number. Without a suggestion only the code goes out, as now.
  const suggestion =
    error instanceof SetupPortConflictError && error.suggestedPort !== undefined
      ? { suggestedPort: error.suggestedPort }
      : {};
  return response({ error: code, errorCode: code, ...suggestion }, status);
}
/** The server rechecks with the same rules before handing it to the host. The host does not trust this and validates again. */
function readProvision(body: Record<string, unknown>): SetupProvisionRequest | undefined {
  const request: SetupProvisionRequest = {};
  const created = body.createProfile;
  if (created !== undefined && created !== null) {
    if (typeof created !== "object" || Array.isArray(created))
      throw new Error("setup_invalid_request");
    const entry = created as Record<string, unknown>;
    const description = validateProfileDescription(entry.description);
    request.createProfile = {
      name: validateProfileName(entry.name),
      ...(description ? { description } : {}),
    };
  }
  const keys = body.provisionKeys;
  if (keys !== undefined && keys !== null) {
    if (!Array.isArray(keys) || keys.length > 10) throw new Error("setup_invalid_request");
    const names = [...new Set(keys.map((name) => validateProfileName(name)))];
    if (names.length) request.provisionKeys = names;
  }
  return request.createProfile || request.provisionKeys ? request : undefined;
}
export async function GET(req: NextRequest) {
  const userId = getUserId(req);
  if (!userId) return response({ errorCode: "unauthorized" }, 401);
  try {
    const job = req.nextUrl.searchParams.get("job");
    return response(job ? { job: getSetupJob(userId, job) } : await setupCapabilities(userId));
  } catch (error) {
    return failure(error);
  }
}
export async function POST(req: NextRequest) {
  const userId = getUserId(req);
  if (!userId) return response({ errorCode: "unauthorized" }, 401);
  if (
    !sameOriginMutation(
      req.headers.get("origin"),
      req.headers.get("host"),
      req.headers.get("sec-fetch-site"),
    )
  )
    return failure(new Error("setup_bad_origin"));
  try {
    if (!req.headers.get("content-type")?.includes("application/json"))
      throw new Error("setup_invalid_request");
    const body = await readBody(req);
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new Error("setup_invalid_request");
    if (body.action === "cancel") return response({ job: cancelSetupJob(userId, body.jobId) });
    if (body.action === "connect-url") return response(await connectSetupUrl(userId, body));
    // Managed SSH (dedicated key, verified host key). Admin only — the service layer decides.
    if (body.action === "ssh-public-key") return response(await sshPublicKey(userId));
    if (body.action === "ssh-scan") return response(await sshScanHost(userId, body));
    if (body.action === "ssh-register") return response(await sshRegisterHost(userId, body));
    if (body.action === "ssh-remove") return response(await sshRemoveHost(userId, body.hostId));
    if (body.action === "ssh-system-info") return response(await sshSystemInfo(userId));
    if (body.action === "ssh-system-add") return response(await sshSystemAdd(userId, body));
    if (body.mode !== "local" && body.mode !== "ssh") throw new Error("setup_invalid_request");
    const target: HostTarget =
      body.mode === "local"
        ? { mode: "local" }
        : { mode: "ssh", hostId: typeof body.hostId === "string" ? body.hostId : "" };
    if (body.action === "discover")
      return response({ candidates: await discoverSetupHost(userId, target) });
    // Before install the candidate does not exist — only then may candidateId be empty, and the server finds it again after install.
    const installHermes = body.action === "prepare" && body.installHermes === true;
    if (
      !installHermes &&
      (typeof body.candidateId !== "string" || !body.candidateId || body.candidateId.length > 256)
    )
      throw new Error("setup_invalid_request");
    if (body.action === "inspect")
      return response(await inspectSetupHost(userId, target, body.candidateId));
    // An immediate response that creates no job. The result is just one verdict and no command output is included.
    if (body.action === "check-model")
      return response({ model: await checkSetupModel(userId, target, body.candidateId) });
    if (body.action === "prepare") {
      if (
        !Array.isArray(body.profiles) ||
        body.profiles.length > 256 ||
        body.profiles.some((name: unknown) => typeof name !== "string" || !isValidProfileName(name))
      )
        throw new Error("setup_invalid_request");
      // If the candidate already has a timezone the host ignores this. Here only the shape is checked.
      const timezone =
        body.timezone === undefined || body.timezone === null
          ? undefined
          : validateTimezone(body.timezone);
      // The resume target. Whether it is the same user, same target and a failed job is decided by the service layer.
      if (
        body.resumeFrom !== undefined &&
        body.resumeFrom !== null &&
        (typeof body.resumeFrom !== "string" || !body.resumeFrom || body.resumeFrom.length > 64)
      )
        throw new Error("setup_invalid_request");
      const resumeFrom = typeof body.resumeFrom === "string" ? body.resumeFrom : undefined;
      // Included only when the screen accepted the suggestion. The value is validated once here and once more on the host.
      const setPort =
        body.setPort === undefined || body.setPort === null
          ? undefined
          : validateSetupPort(body.setPort);
      // The worker propagation checkbox. When absent, host settings are not touched (old screens, URL connections).
      if (
        body.workerPropagation !== undefined &&
        body.workerPropagation !== null &&
        typeof body.workerPropagation !== "boolean"
      )
        throw new Error("setup_invalid_request");
      const workerPropagation =
        typeof body.workerPropagation === "boolean" ? body.workerPropagation : undefined;
      return response(
        {
          job: await startSetup(
            userId,
            target,
            installHermes ? "" : body.candidateId,
            [...new Set<string>(body.profiles)],
            timezone,
            readProvision(body),
            installHermes,
            resumeFrom,
            setPort,
            workerPropagation,
          ),
        },
        202,
      );
    }
    throw new Error("setup_invalid_request");
  } catch (error) {
    return failure(error);
  }
}
