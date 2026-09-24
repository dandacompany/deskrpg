/**
 * SSH argument assembly. It is a pure function, so win32 paths are tested as-is on a Mac — upstream Hermes Desktop's
 * `ssh-connection.ts` also split out "Command construction (pure)" for the same reason.
 *
 * Windows OpenSSH has never implemented ControlMaster mux sockets. So on win32 we do not use a control socket
 * and instead spawn one `ssh -N -L` child per tunnel. We lose auth-handshake reuse, but we have
 * one tunnel per gateway, so the impact is small.
 */
import { isWindows, nullDevicePath } from "./platform";

export function usesControlMaster(platform: string): boolean {
  return !isWindows(platform);
}

/** Forward spec. The local side is always 127.0.0.1 — the tunnel must not be exposed externally. */
function forwardSpec(localPort: number, remotePort: number): string {
  return `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`;
}

export function tunnelArgs(input: {
  platform: string;
  routeArgs: string[];
  routeOptions: string[];
  dest: string;
  socket: string;
  localPort: number;
  remotePort: number;
}): string[] {
  const common = ["-o", "ExitOnForwardFailure=yes", "-N", "-T", "--", input.dest];
  if (!usesControlMaster(input.platform)) {
    // No control socket. This child opens the forward itself.
    return [
      ...input.routeArgs,
      ...input.routeOptions,
      "-L",
      forwardSpec(input.localPort, input.remotePort),
      ...common,
    ];
  }
  return [
    ...input.routeArgs,
    // Same as current behavior — drop the last two option pairs and append the master options.
    ...input.routeOptions.slice(0, -4),
    "-M",
    "-S",
    input.socket,
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ClearAllForwardings=yes",
    "-N",
    "-T",
    "--",
    input.dest,
  ];
}

export function forwardArgs(input: {
  platform: string;
  socket: string;
  hostId: string;
  localPort: number;
  remotePort: number;
}): string[] {
  if (!usesControlMaster(input.platform)) throw new Error("setup_invalid_request");
  return [
    "-F",
    nullDevicePath(input.platform),
    "-S",
    input.socket,
    "-O",
    "forward",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-L",
    forwardSpec(input.localPort, input.remotePort),
    "--",
    input.hostId,
  ];
}
