"use client";

import { useCallback, useState, useSyncExternalStore, type ReactNode } from "react";

import WebglUnavailable from "@/components/WebglUnavailable";
import { detectWebglSupport } from "@/lib/webgl-support";

// WebGL availability has no event to subscribe to and does not change during a page's lifetime
// (the only action that changes it, "retry", is a full reload) — measure once and cache.
const subscribeWebgl = () => () => {};
let cachedSupport: boolean | null = null;
function webglAvailable(): boolean {
  if (cachedSupport === null) {
    cachedSupport = detectWebglSupport(typeof document === "undefined" ? null : document);
  }
  return cachedSupport;
}
// It cannot be decided on the server. `null` means "not checked yet", and it splits into the client
// snapshot right after hydration — measuring in the `useState` initial value makes server and client renders disagree.
const serverWebglAvailable = () => null;

export type WebglGateProps = {
  /** The WebGL availability check. By default it tries creating a canvas with the real `document`. */
  detect?: () => boolean;
  /** Mounted only when the check passes. The argument is a callback reporting a fatal failure during the session. */
  renderWorkspace: (onFatal: () => void) => ReactNode;
  /** What to show before the check finishes. */
  renderChecking: () => ReactNode;
  /** "다시 시도" — by default a full reload. */
  onRetry?: () => void;
};

function reloadPage() {
  if (typeof window !== "undefined") window.location.reload();
}

/**
 * The gate guarding the channel workspace. The workspace mounts only when the check passes —
 * on failure neither the socket connection nor character/channel data requests start. There is no 2D fallback.
 *
 * If the renderer dies during the session, the workspace calls `onFatal`, and the gate immediately
 * unmounts the workspace so no half-alive channel screen is left behind.
 *
 * The workspace is taken as a callback rather than an element so this file does not import
 * `GamePageClient` — the wiring is done by `GameWebglGate.tsx`.
 */
export function WebglGate({ detect, renderWorkspace, renderChecking, onRetry }: WebglGateProps) {
  const supported = useSyncExternalStore<boolean | null>(
    subscribeWebgl,
    detect ?? webglAvailable,
    serverWebglAvailable,
  );
  const [fatal, setFatal] = useState(false);

  const handleFatal = useCallback(() => {
    setFatal(true);
  }, []);

  if (fatal || supported === false) return <WebglUnavailable onRetry={onRetry ?? reloadPage} />;
  if (supported === null) return <>{renderChecking()}</>;
  return <>{renderWorkspace(handleFatal)}</>;
}
