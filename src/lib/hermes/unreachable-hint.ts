/**
 * Narrows down the cause of a connection failure.
 *
 * "Could not connect" alone doesn't tell the user what to fix. In practice the most common
 * cause is not the address itself but **where the address is seen from** — when DeskRPG runs inside
 * a container, `127.0.0.1` points to the container itself, not Hermes. The address opens fine in
 * the browser, so the user is sure it's correct, and that certainty blocks the diagnosis.
 */
export function diagnoseUnreachable(opts: {
  baseUrl: string;
  inContainer: boolean;
}): "gateway_loopback_in_container" | "failed_to_reach_test_endpoint" {
  if (opts.inContainer && isLoopback(opts.baseUrl)) return "gateway_loopback_in_container";
  return "failed_to_reach_test_endpoint";
}

function isLoopback(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  // The URL parser gives IPv6 **with** the brackets kept — measured: new URL("http://[::1]:8643").hostname
  // === "[::1]". We assumed they were stripped and a test caught it.
  return host === "localhost" || host === "[::1]" || host === "::1" || host.startsWith("127.");
}
