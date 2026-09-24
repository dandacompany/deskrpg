/**
 * `.test.tsx` files import this module **first**. `@testing-library/react` requires a global
 * `document` at load time, so if the order is off it blows up at import time.
 *
 * The runner is `tsx --test`, so there is no separate environment (like a jsdom preset). The happy-dom window is
 * planted into globals directly here.
 */
import Module from "node:module";
import { Window } from "happy-dom";

// Screen components use `import "*.css"` as a side effect at module scope (e.g. lookbook.css).
// `tsx --test` has no bundler and dies with a syntax error trying to parse CSS as JS — tests
// need no styles, so treat it as an empty module.
(
  Module as unknown as { _extensions: Record<string, (m: unknown, filename: string) => void> }
)._extensions[".css"] = (m) => {
  (m as { exports: unknown }).exports = {};
};

const win = new Window({ url: "https://localhost/" });

const g = globalThis as unknown as Record<string, unknown>;

// Node 22 exposes `navigator` only as a getter — plain assignment is a TypeError.
// Plant everything with defineProperty to avoid that whole class at once.
function install(key: string, value: unknown) {
  Object.defineProperty(g, key, { value, writable: true, configurable: true });
}

for (const key of [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "Element",
  "Node",
  "Event",
  "CustomEvent",
  "MouseEvent",
  "KeyboardEvent",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "localStorage",
  "sessionStorage",
  // CodeMirror (ArtifactEditor) requires it — happy-dom creates it but does not plant it
  // in globals by default.
  "MutationObserver",
  "ResizeObserver",
  "IntersectionObserver",
  "Range",
  "Selection",
  "DocumentFragment",
  "Text",
]) {
  install(key, (win as unknown as Record<string, unknown>)[key]);
}
install("window", win);
// `next/link` reads `self` inside its module — without it, screens that draw a Link blow up entirely at render
// with "self is not defined" (measured on the wizard's ④ placement).
install("self", g);

// React 19 uses this flag to detect the act() environment. Without it warnings pour out on every state update.
install("IS_REACT_ACT_ENVIRONMENT", true);
