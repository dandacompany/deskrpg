/**
 * Decide whether the browser can render the 3D office.
 *
 * Now that the 2D fallback is gone, the channel screen itself is meaningless without
 * WebGL — so this check must pass before opening the socket. It is a pure function
 * that takes the browser API as an injected dependency, so tests can reproduce all
 * three cases: context returned, `null`, and exception.
 */

/** The minimal canvas shape this check needs. */
export interface WebglProbeCanvas {
  getContext(contextId: string): unknown;
}

/** The minimal document shape this check needs (the real `document` fits it as-is). */
export interface WebglProbeDocument {
  createElement(tagName: "canvas"): WebglProbeCanvas;
}

/** Tried in this order — three.js works with just webgl even without webgl2. */
const CONTEXT_IDS = ["webgl2", "webgl"] as const;

export function detectWebglSupport(doc: WebglProbeDocument | null | undefined): boolean {
  if (!doc) return false;

  let canvas: WebglProbeCanvas;
  try {
    canvas = doc.createElement("canvas");
  } catch {
    return false;
  }
  if (!canvas || typeof canvas.getContext !== "function") return false;

  for (const contextId of CONTEXT_IDS) {
    try {
      // A browser with hardware acceleration off either returns null here or throws — both count as failure.
      if (canvas.getContext(contextId)) return true;
    } catch {
      // Move on to the next context id.
    }
  }
  return false;
}
