/**
 * URL policy for markdown in the chat window.
 *
 * react-markdown 10's default `urlTransform` only lets through `http(s)`·`irc(s)`·`mailto`·
 * `xmpp` and relative paths, and **wipes every other scheme to an empty string**
 * (`react-markdown/lib/index.js:124,421`). So when an employee outputs an image as inline
 * base64 (`data:image/png;base64,…`), all that's left on screen is a broken icon with
 * `src=""` — with no clue for the user at all (measured live 2026-09-20).
 *
 * That said, `data:` shouldn't be opened wholesale either. `data:image/svg+xml` isn't an
 * image — it's a document that can carry `<script>`, and `data:text/html` needs no
 * explanation. So only **the raster types in an image slot (`<img src>`)** are opened — not
 * in a link (`<a href>`).
 */
import { DATA_IMAGE_RASTER } from "./chat-file-link";

type UrlNode = { tagName?: string } | null | undefined;

const SAFE_PROTOCOL = /^(https?|ircs?|mailto|xmpp)$/i;

/** Same judgment as react-markdown's default — no protocol means a relative path. */
function isSafeByDefault(value: string): boolean {
  const colon = value.indexOf(":");
  const questionMark = value.indexOf("?");
  const numberSign = value.indexOf("#");
  const slash = value.indexOf("/");
  return (
    colon === -1 ||
    (slash !== -1 && colon > slash) ||
    (questionMark !== -1 && colon > questionMark) ||
    (numberSign !== -1 && colon > numberSign) ||
    SAFE_PROTOCOL.test(value.slice(0, colon))
  );
}

export function chatUrlTransform(value: string, key: string, node: UrlNode): string {
  if (isSafeByDefault(value)) return value;
  if (key === "src" && node?.tagName === "img" && DATA_IMAGE_RASTER.test(value)) return value;
  return "";
}
