/**
 * Decides whether the connection wizard can open local/SSH, and **why it can't**.
 *
 * It used to return only a boolean, so the screen showed the single sentence "호스트 접근이 허용되지 않습니다" —
 * you could not tell whether the switch was off, you were not an admin, or ssh/Hermes was missing. The verdict names
 * what is actually missing: it blocks not because it's Docker, but because Hermes is not in the container and
 * installing it there would vanish on redeploy.
 */
import type { SetupCapabilities } from "./types";

export type LocalReason =
  "not_admin" | "disabled" | "unsupported_platform" | "container_without_hermes";
export type SshReason = "not_admin" | "disabled" | "ssh_missing";

export type CapabilityProbe = {
  role: string | undefined;
  /** Was it turned off by the operator switch (DESKRPG_HOST_SETUP_ENABLED=0)? */
  switchedOff: boolean;
  installAllowed: boolean;
  platform: string;
  hasSsh: boolean;
  /** Checked on win32 only — is there PowerShell to launch host commands? */
  hasPowershell: boolean;
  inContainer: boolean;
  /** Is Hermes installed in this server user's home? */
  localHermesFound: boolean;
  hostLabel: string;
  sshHosts: { id: string; label: string }[];
};

export function describeCapabilities(p: CapabilityProbe): SetupCapabilities {
  const gate: LocalReason | null =
    p.role !== "system_admin" ? "not_admin" : p.switchedOff ? "disabled" : null;
  let localReason: LocalReason | null = gate;
  // win32 itself used to be blocked. With Hermes officially supporting Windows (install.ps1,
  // hermes_cli/gateway_windows.py) there is no reason to block it. The only thing that can be missing now is PowerShell.
  if (!localReason && p.platform === "win32" && !p.hasPowershell)
    localReason = "unsupported_platform";
  // python3 is not a reason — if missing, install fetches python into the user home with uv (HOST_LAUNCHER).
  // If Hermes is in the container (baked into the image), use it as-is. If not, don't suggest installing —
  // the container is recreated on redeploy and is separate from the Hermes running on the host.
  if (!localReason && p.inContainer && !p.localHermesFound)
    localReason = "container_without_hermes";
  const sshReason: SshReason | null = gate ?? (p.hasSsh ? null : "ssh_missing");
  const local = localReason === null;
  return {
    local,
    ssh: sshReason === null,
    hostLabel: local || sshReason === null ? p.hostLabel : "",
    sshHosts: sshReason === null ? p.sshHosts : [],
    localHermesFound: p.localHermesFound,
    canInstallHermes: local && !p.localHermesFound && p.installAllowed,
    canInstallHermesSsh: sshReason === null && p.installAllowed,
    localReason,
    sshReason,
  };
}
