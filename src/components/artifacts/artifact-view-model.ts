import {
  ARTIFACT_CATEGORIES,
  type ArtifactCategory,
  type ArtifactKind,
  type ArtifactSummary,
} from "@/lib/hermes/deskrpg-plugin-types";

export const TEXT_PREVIEW_MAX_BYTES = 512 * 1024;
export const CSV_MAX_ROWS = 1000;

export type ViewerKind =
  | "markdown"
  | "text"
  | "pdf"
  | "image"
  | "svg"
  | "audio"
  | "video"
  | "html"
  | "code"
  | "csv"
  | "link"
  | "download";

type Shape = { kind: ArtifactKind; mime: string; filename: string };

const ext = (filename: string) => (/\.([a-z0-9]{1,8})$/i.exec(filename)?.[1] ?? "").toLowerCase();

const CODE_LANG: Record<string, string> = {
  ts: "ts",
  tsx: "tsx",
  js: "js",
  jsx: "jsx",
  mjs: "js",
  cjs: "js",
  json: "json",
  jsonl: "json",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  cpp: "cpp",
  cs: "csharp",
  php: "php",
  sh: "bash",
  bash: "bash",
  sql: "sql",
  css: "css",
  html: "html",
  htm: "html",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  md: "markdown",
  svg: "xml",
  txt: "text",
};

export function codeLanguageFor(filename: string): string {
  return CODE_LANG[ext(filename)] ?? "text";
}

export function viewerFor(a: Shape): ViewerKind {
  const e = ext(a.filename);
  const mime = a.mime.toLowerCase();
  if (a.kind === "link") return "link";
  if (a.kind === "web" || mime === "text/html") return "html";
  if (mime === "image/svg+xml" || e === "svg") return "svg";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (mime === "application/pdf" || e === "pdf") return "pdf";
  if (e === "md" || mime === "text/markdown") return "markdown";
  if (e === "csv" || mime === "text/csv") return "csv";
  if (e === "txt") return "text";
  if (e in CODE_LANG || mime.startsWith("text/") || mime === "application/json") return "code";
  return "download";
}

const EDITABLE_VIEWERS: ReadonlySet<ViewerKind> = new Set([
  "markdown",
  "text",
  "html",
  "code",
  "csv",
  "link",
]);

export function isEditable(a: Shape): boolean {
  return EDITABLE_VIEWERS.has(viewerFor(a));
}

export function hasRenderedMode(v: ViewerKind): boolean {
  return v === "markdown" || v === "svg" || v === "html";
}

export function safeHttpUrl(text: string): string | null {
  const first = (text.split(/\r?\n/, 1)[0] ?? "").trim();
  if (!first) return null;
  try {
    const url = new URL(first);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function parseCsv(
  text: string,
  maxRows = CSV_MAX_ROWS,
): { rows: string[][]; truncated: boolean } {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      if (rows.length >= maxRows) return { rows, truncated: i < text.length - 1 };
    } else cell += ch;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return { rows: rows.slice(0, maxRows), truncated: rows.length > maxRows };
}

export type SourceTarget =
  | { type: "kanban"; taskId: string }
  | { type: "chat"; profile: string }
  | { type: "cron"; jobId: string | null; profile: string };

export function sourceTarget(
  a: Pick<ArtifactSummary, "source_kind" | "task_id" | "job_id" | "profile">,
): SourceTarget {
  if (a.source_kind === "kanban" && a.task_id) return { type: "kanban", taskId: a.task_id };
  if (a.source_kind === "cron")
    return { type: "cron", jobId: a.job_id ?? null, profile: a.profile };
  return { type: "chat", profile: a.profile };
}

const BRANDS: Array<[RegExp, string]> = [
  [/(^|\.)github\.com$/, "github"],
  [/(^|\.)(youtube\.com|youtu\.be)$/, "youtube"],
  [/(^|\.)figma\.com$/, "figma"],
  [/(^|\.)gitlab\.com$/, "gitlab"],
  [/(^|\.)(twitter\.com|x\.com)$/, "twitter"],
  [/(^|\.)linkedin\.com$/, "linkedin"],
];

const KIND_TO_CATEGORY = new Map<ArtifactKind, ArtifactCategory>(
  (
    Object.entries(ARTIFACT_CATEGORIES) as Array<[ArtifactCategory, readonly ArtifactKind[]]>
  ).flatMap(([category, kinds]) => kinds.map((kind) => [kind, category] as const)),
);

/** Groups `kind` into a tab category (media/file/link). Every `ARTIFACT_KINDS` value falls into one of the three. */
export function categoryOf(kind: ArtifactKind): ArtifactCategory {
  return KIND_TO_CATEGORY.get(kind) ?? "file";
}

export function brandIconFor(url: string): string | null {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  return BRANDS.find(([re]) => re.test(host))?.[1] ?? null;
}
