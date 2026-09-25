/**
 * Actions the client sends on its own in the background. Their denial is answered by the
 * component that asked (the meeting button shows its own state), so a toast would only repeat it
 * — and the probe runs again right after every reconnect, before player:join lands.
 */
const BACKGROUND_PROBES = new Set(["meeting:availability"]);

export function shouldToastAccessDenied(data: { action?: string; errorCode?: string }): boolean {
  return !(data.action && BACKGROUND_PROBES.has(data.action));
}
