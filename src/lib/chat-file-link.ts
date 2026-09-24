/**
 * Decides whether a link in chat is a **file** — if so, the UI attaches a download icon.
 *
 * Why this exists: even when a staff member created a document and shared it as a link,
 * chat showed nothing but underlined text. The download button existed only on the
 * artifact viewer (`ArtifactViewer.tsx:371`) and card attachments (`TaskDrawer.tsx:760`),
 * so a file received mid-conversation could only be opened in a new tab and left to the
 * browser (observed 2026-09-20).
 *
 * Not every link gets an icon — putting one on every reference-site link would become
 * noise, and it would overlap with preview-card promotion. The verdict branches two ways:
 *
 *   1. Our own file paths (artifact content · card attachments) — these arrive as relative paths.
 *   2. Any other http(s) link, only when the last path segment's extension is a file extension.
 *
 * A pure function. It's in the client bundle, so it imports neither `node:*` nor `@/db`.
 */

/** Extensions the browser opens as a page are excluded — that's a link, not a file. */
const FILE_EXTENSIONS = new Set([
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "odt",
  "ods",
  "odp",
  "csv",
  "tsv",
  "json",
  "xml",
  "yaml",
  "yml",
  "md",
  "txt",
  "rtf",
  "log",
  "zip",
  "tar",
  "gz",
  "tgz",
  "7z",
  "rar",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "avif",
  "bmp",
  "ico",
  "mp3",
  "wav",
  "ogg",
  "flac",
  "mp4",
  "webm",
  "mov",
  "m4a",
]);

/** Artifact content: `/api/channels/<id>/artifacts/<id>/versions/<n>/content` */
const ARTIFACT_CONTENT = /^\/api\/channels\/[^/]+\/artifacts\/[^/]+\/versions\/\d+\/content$/;
/** Card attachment: `/api/channels/<id>/kanban/attachments/<id>` */
const KANBAN_ATTACHMENT = /^\/api\/channels\/[^/]+\/kanban\/attachments\/[^/]+$/;

/**
 * **Raster only** among inline images. `svg+xml` is excluded — it's a document that can
 * carry a script. This list is shared between `markdown-url.ts`'s address policy and this
 * file's download verdict.
 */
export const DATA_IMAGE_RASTER = /^data:image\/(png|jpe?g|gif|webp|avif|bmp);/i;

export type ChatFileLink = {
  /** The address to use for downloading. For an artifact, `?download=1` is appended (the server supplies Content-Disposition). */
  href: string;
  /** The name to use for the `download` attribute. Left empty on paths where the server supplies the name. */
  filename: string | undefined;
};

function extensionOf(pathname: string): string | null {
  const last = pathname.split("/").pop() ?? "";
  const dot = last.lastIndexOf(".");
  if (dot <= 0 || dot === last.length - 1) return null;
  return last.slice(dot + 1).toLowerCase();
}

export function chatFileLink(href: string | undefined | null): ChatFileLink | null {
  if (!href) return null;

  // Images a staff member created often arrive as inline base64 — to the user, that's a file too.
  const inline = DATA_IMAGE_RASTER.exec(href);
  if (inline) {
    const ext = inline[1].toLowerCase() === "jpg" ? "jpeg" : inline[1].toLowerCase();
    return { href, filename: `image.${ext}` };
  }

  // A relative path is one of our own routes. Give `new URL` a base so query and hash split correctly.
  const base = "https://deskrpg.invalid";
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  const isOwnPath = href.startsWith("/");
  if (isOwnPath && ARTIFACT_CONTENT.test(url.pathname)) {
    url.searchParams.set("download", "1");
    return { href: `${url.pathname}${url.search}`, filename: undefined };
  }
  if (isOwnPath && KANBAN_ATTACHMENT.test(url.pathname)) {
    return { href, filename: undefined };
  }

  const ext = extensionOf(decodeURIComponent(url.pathname));
  if (!ext || !FILE_EXTENSIONS.has(ext)) return null;
  const name = decodeURIComponent(url.pathname).split("/").pop() || undefined;
  return { href, filename: name };
}
