import { PLUGIN_INSTALL_COMMAND } from "@/lib/hermes/plugin-install-command";

/**
 * Turns a gate failure into a screen branch.
 *
 * **Never makes the judgment itself.** The judgment is made solely by the server's
 * `automation-gate.ts`, and its result is carried by `cron-access.ts`'s
 * `pluginGateResponse` as a status code + code. This file only translates that table into
 * screen-side names — adding a new branch here would create a second place where the
 * judgment is made.
 *
 * Ships in the client bundle: does not import `node:*` or `@/db`.
 */
export const GATE_FALLBACK_MIN_VERSION = "0.6.0";

export type GateBlocker =
  | { kind: "gateway_not_bound" }
  | { kind: "plugin_absent"; command: string }
  | { kind: "plugin_unauthorized" }
  | { kind: "plugin_upgrade_required"; minVersion: string; command: string }
  | { kind: "unreachable" }
  | { kind: "timeout" }
  | { kind: "other"; status: number; code: string; message: string };

export type GateFailure = {
  status: number;
  code: string;
  message?: string;
  minVersion?: string;
};

export function classifyGateFailure(failure: GateFailure): GateBlocker {
  switch (failure.code) {
    case "gateway_not_bound":
      return { kind: "gateway_not_bound" };
    case "plugin_absent":
      return { kind: "plugin_absent", command: PLUGIN_INSTALL_COMMAND };
    case "plugin_unauthorized":
      return { kind: "plugin_unauthorized" };
    case "plugin_upgrade_required":
      return {
        kind: "plugin_upgrade_required",
        minVersion: failure.minVersion || GATE_FALLBACK_MIN_VERSION,
        command: PLUGIN_INSTALL_COMMAND,
      };
    case "timeout":
      return { kind: "timeout" };
    case "unreachable":
    // A case where we don't know why the probe failed. What the user can do is the same as for unreachable.
    case "plugin_unknown":
      return { kind: "unreachable" };
    default:
      return {
        kind: "other",
        status: failure.status,
        code: failure.code,
        message: failure.message ?? "",
      };
  }
}

/** Is this a value that should be drawn as a checklist? — expressing a connectivity/server-status problem as a step would be a lie. */
export function isSetupBlocker(blocker: GateBlocker): boolean {
  return (
    blocker.kind === "gateway_not_bound" ||
    blocker.kind === "plugin_absent" ||
    blocker.kind === "plugin_unauthorized" ||
    blocker.kind === "plugin_upgrade_required"
  );
}
