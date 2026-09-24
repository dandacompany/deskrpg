/**
 * Decides, **from the address alone**, whether we can handle the host of an already registered gateway.
 *
 * Updating is an action that must run commands on the host, so we first have to know which host. All we
 * know is the gateway record's `baseUrl`, and it splits three ways.
 *
 *   - loopback      — the same host DeskRPG runs on. Handled by the local executor.
 *   - ssh-registered — an address made by `registerSshTransport`. The host id is in the registry.
 *   - anything else — somewhere we can't run commands (e.g. `host.docker.internal` as seen
 *                  from a container, or a remote Hermes run by someone else).
 *
 * Pure function — looks at no files or network. Actually extracting the ssh host id requires
 * reading the registry, so `transport.ts` does that.
 */

/** Fake domain used by `registerSshTransport`. Must match SUFFIX in transport.ts. */
const SSH_SUFFIX = ".deskrpg-ssh.invalid";

export type GatewayHostKind =
  { mode: "local"; port: number } | { mode: "ssh" } | { mode: "unsupported" };

function isLoopbackHostname(hostname: string): boolean {
  const host =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

export function classifyGatewayHost(baseUrl: string): GatewayHostKind {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return { mode: "unsupported" };
  }
  if (url.hostname.endsWith(SSH_SUFFIX)) return { mode: "ssh" };
  if (url.protocol === "http:" && isLoopbackHostname(url.hostname) && url.port) {
    const port = Number(url.port);
    if (Number.isInteger(port) && port > 0 && port <= 65535) return { mode: "local", port };
  }
  return { mode: "unsupported" };
}
