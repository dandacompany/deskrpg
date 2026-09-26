"use client";
import {
  Component,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import { ArrowUpRight, Copy, Download, Pencil, Trash2, X } from "lucide-react";

import MarkdownContent from "@/components/ui/MarkdownContent";
import { useT } from "@/lib/i18n";
import ArtifactEditor, { type ArtifactEditorHandle } from "./ArtifactEditor";
import ArtifactProvenance from "./ArtifactProvenance";
import SessionSourcesList from "./SessionSourcesList";
import type { ArtifactDetailView, ArtifactsApi } from "./artifacts-api";
import {
  codeLanguageFor,
  hasRenderedMode,
  isEditable,
  sourceTarget,
  TEXT_PREVIEW_MAX_BYTES,
  viewerFor,
  type SourceTarget,
  type ViewerKind,
} from "./artifact-view-model";
import CsvViewer from "./viewers/CsvViewer";
import HtmlViewer from "./viewers/HtmlViewer";
import LinkViewer from "./viewers/LinkViewer";
import MediaViewer from "./viewers/MediaViewer";

// Heavy (pdf.js/shiki/dompurify) — lazy-load only when actually used.
const PdfViewer = lazy(() => import("./viewers/PdfViewer"));
const CodeViewer = lazy(() => import("./viewers/CodeViewer"));
const SvgViewer = lazy(() => import("./viewers/SvgViewer"));

/** Viewers that need the body read as text to render. The rest render with just a URL. */
const TEXT_VIEWERS: ReadonlySet<ViewerKind> = new Set([
  "markdown",
  "text",
  "html",
  "csv",
  "link",
  "code",
  "svg",
]);

/** Viewers that turn on the render/source toggle. */
const showsModeToggle = hasRenderedMode;

type Content = { version: number; text: string; truncated: boolean };

class RenderBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** Called before the viewer (or the modal holding it) closes — if there are unsaved edits, confirm, then `proceed`. */
export type ArtifactViewerHandle = { requestClose(proceed: () => void): void };

export type ArtifactViewerProps = {
  ref?: Ref<ArtifactViewerHandle>;
  api: ArtifactsApi;
  artifactId: string;
  /**
   * When this changes, refetch the detail and jump back to the latest version (this artifact's
   * `artifact.versioned`). While editing, keep the edit and just show a notice, then refetch once
   * editing ends.
   */
  reloadKey: number;
  onOpenSource(target: SourceTarget): void;
  onDeleted(id: string): void;
  onClose(): void;
};

/**
 * One artifact's detail. Handles version selection, render/source, copy, download, go-to-source,
 * and delete (confirmed in-modal), and renders the body with the lightweight viewer `viewerFor`
 * picks. If the viewer throws, it falls back to download.
 */
export default function ArtifactViewer({
  ref,
  api,
  artifactId,
  reloadKey,
  onOpenSource,
  onDeleted,
  onClose,
}: ArtifactViewerProps) {
  const t = useT();
  const [detail, setDetail] = useState<ArtifactDetailView | null>(null);
  const [version, setVersion] = useState<number | null>(null);
  const [mode, setMode] = useState<"rendered" | "source">("rendered");
  const [loaded, setLoaded] = useState<Content | null>(null);
  const [blobLoaded, setBlobLoaded] = useState<{ version: number; blob: Blob } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editorRef = useRef<ArtifactEditorHandle | null>(null);
  const [editingArtifactId, setEditingArtifactId] = useState(artifactId);
  const [appliedReload, setAppliedReload] = useState(reloadKey);

  // Adjust derived state during render. Turn off editing when switching to a different artifact.
  // Even if an external reload is requested (reloadKey), defer applying it while editing so an
  // unsaved body isn't discarded, and apply it once editing ends.
  if (editingArtifactId !== artifactId) {
    setEditingArtifactId(artifactId);
    if (editing) setEditing(false);
  }
  if (appliedReload !== reloadKey && !editing) setAppliedReload(reloadKey);
  const newerWhileEditing = editing && appliedReload !== reloadKey;

  const requestClose = (proceed: () => void) => {
    if (editing && editorRef.current) editorRef.current.requestClose(proceed);
    else proceed();
  };
  useImperativeHandle(ref, () => ({ requestClose }));

  useEffect(() => {
    let alive = true;
    api.get(artifactId).then(
      (next) => {
        if (!alive) return;
        setError(null);
        setDetail(next);
        setVersion(next.artifact.current_version);
      },
      (err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      alive = false;
    };
  }, [api, artifactId, appliedReload]);

  const artifact = detail?.artifact.id === artifactId ? detail.artifact : null;
  const selected = artifact ? detail?.versions.find((v) => v.version === version) : undefined;
  const shape = artifact && {
    kind: artifact.kind,
    mime: selected?.mime ?? artifact.mime,
    filename: selected?.filename ?? artifact.filename,
  };
  const viewer: ViewerKind | null = shape ? viewerFor(shape) : null;
  const needsText = !!viewer && TEXT_VIEWERS.has(viewer) && !artifact?.missing;
  const needsBlob = viewer === "pdf" && !artifact?.missing;
  // When switching versions, don't show the old body until the new one arrives.
  const content = needsText && loaded?.version === version ? loaded : null;
  const blobContent = needsBlob && blobLoaded?.version === version ? blobLoaded.blob : null;

  useEffect(() => {
    if (!needsText || version === null) return;
    let alive = true;
    api.fetchText(artifactId, version, TEXT_PREVIEW_MAX_BYTES).then(
      (next) => {
        if (alive) setLoaded({ version, ...next });
      },
      (err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      alive = false;
    };
  }, [api, artifactId, version, needsText]);

  useEffect(() => {
    if (!needsBlob || version === null) return;
    let alive = true;
    api.fetchBlob(artifactId, version).then(
      (blob) => {
        if (alive) setBlobLoaded({ version, blob });
      },
      (err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      alive = false;
    };
  }, [api, artifactId, version, needsBlob]);

  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
      if (savedTimer.current) clearTimeout(savedTimer.current);
    },
    [],
  );

  const copy = useCallback((value: string) => {
    void navigator.clipboard?.writeText(value).then(() => {
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1500);
    });
  }, []);

  const remove = async () => {
    setDeleting(true);
    try {
      await api.remove(artifactId);
      onDeleted(artifactId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDeleting(false);
      setConfirming(false);
    }
  };

  const saveEdit = async (text: string, note: string) => {
    if (!shape) return;
    const saved = await api.addVersion(artifactId, {
      content: text,
      filename: shape.filename,
      note: note.trim() ? note.trim() : undefined,
    });
    const next = await api.get(artifactId);
    setError(null);
    setDetail(next);
    setVersion(saved.version);
    setEditing(false);
    setJustSaved(true);
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setJustSaved(false), 3000);
  };

  if (!artifact || version === null || !viewer) {
    return (
      <div className="p-4 text-xs text-text-dim">
        {error ? `${t("artifacts.error")} — ${error}` : t("common.loading")}
      </div>
    );
  }

  const downloadHref = api.contentUrl(artifactId, version, true);
  const downloadLink = (
    <a
      href={downloadHref}
      download
      className="inline-flex items-center gap-1 underline text-primary"
    >
      <Download className="w-3.5 h-3.5" />
      {t("artifacts.download")}
    </a>
  );
  const contentUrl = api.contentUrl(artifactId, version);
  const btn =
    "inline-flex items-center gap-1 px-2 py-1 rounded-md bg-surface-raised text-text-secondary hover:brightness-125 disabled:opacity-50";

  const body = (() => {
    if (artifact.missing) return <p className="text-text-secondary">{t("artifacts.missing")}</p>;
    if (viewer === "image")
      return (
        <img src={contentUrl} alt={artifact.title} className="max-w-full mx-auto rounded-md" />
      );
    if (viewer === "audio" || viewer === "video")
      return <MediaViewer kind={viewer} src={contentUrl} />;
    if (viewer === "download")
      return (
        <p className="text-text-secondary flex items-center gap-2">
          {t("artifacts.noPreview")} {downloadLink}
        </p>
      );
    if (viewer === "pdf") {
      if (!blobContent) return <p className="text-text-dim">{t("common.loading")}</p>;
      return (
        <Suspense fallback={<p className="text-text-dim">{t("common.loading")}</p>}>
          <PdfViewer blob={blobContent} />
        </Suspense>
      );
    }
    if (!content) return <p className="text-text-dim">{t("common.loading")}</p>;
    const { text } = content;
    const pre = <pre className="whitespace-pre-wrap font-mono text-xs break-words">{text}</pre>;
    const filename = shape!.filename;
    if (mode === "source" && showsModeToggle(viewer)) {
      const sourceLanguage = viewer === "svg" ? "xml" : viewer === "html" ? "html" : "markdown";
      return (
        <Suspense fallback={pre}>
          <CodeViewer text={text} language={sourceLanguage} />
        </Suspense>
      );
    }
    switch (viewer) {
      case "markdown":
        return <MarkdownContent content={text} />;
      case "html":
        return <HtmlViewer text={text} title={artifact.title} />;
      case "csv":
        return <CsvViewer text={text} />;
      case "link":
        return <LinkViewer text={text} onCopy={copy} copied={copied} />;
      case "svg":
        return (
          <Suspense fallback={pre}>
            <SvgViewer text={text} />
          </Suspense>
        );
      default:
        // text/code
        return (
          <Suspense fallback={pre}>
            <CodeViewer text={text} language={codeLanguageFor(filename)} />
          </Suspense>
        );
    }
  })();

  const copyable = needsText && !!content && viewer !== "link";
  // If the server didn't send a judgment (an old response), show editing, but the mutation route re-checks permission.
  const modifiable = detail?.modifiable !== false;
  const sourceInChannel = detail?.sourceInChannel !== false;
  const editableShape = !!content && !!shape && isEditable(shape) && modifiable;
  // Saving a truncated preview (512 KB) would make a file missing its tail the new version — don't allow editing it.
  const editable = !editing && editableShape && !content.truncated;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex flex-wrap items-center gap-1.5 px-4 py-2 border-b border-border text-xs">
        <h3 className="text-sm font-bold text-text mr-auto break-all">{artifact.title}</h3>
        {!editing && (
          <select
            aria-label={t("artifacts.version")}
            value={version}
            onChange={(e) => setVersion(Number(e.target.value))}
            className="px-1.5 py-1 rounded-md bg-surface-raised text-text-secondary"
          >
            {detail!.versions.map((v) => (
              <option key={v.version} value={v.version} disabled={v.pruned_at !== undefined}>
                {`v${v.version}${v.pruned_at !== undefined ? ` · ${t("artifacts.pruned")}` : ""}`}
              </option>
            ))}
          </select>
        )}
        {!editing && showsModeToggle(viewer) && (
          <div className="inline-flex rounded-md overflow-hidden border border-border">
            {(["rendered", "source"] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                onClick={() => setMode(m)}
                className={`px-2 py-1 ${mode === m ? "bg-primary text-white" : "bg-surface-raised text-text-secondary"}`}
              >
                {t(m === "rendered" ? "artifacts.rendered" : "artifacts.source")}
              </button>
            ))}
          </div>
        )}
        {!editing && copyable && (
          <button type="button" className={btn} onClick={() => copy(content.text)}>
            <Copy className="w-3.5 h-3.5" />
            <span>{copied ? t("artifacts.copied") : t("artifacts.copy")}</span>
          </button>
        )}
        {!editing && (
          <a href={downloadHref} download className={btn}>
            <Download className="w-3.5 h-3.5" />
            <span>{t("artifacts.download")}</span>
          </a>
        )}
        {!editing && (
          <button
            type="button"
            className={btn}
            disabled={!sourceInChannel}
            title={sourceInChannel ? undefined : t("artifacts.goToSourceUnavailable")}
            onClick={() => onOpenSource(sourceTarget(artifact))}
          >
            <ArrowUpRight className="w-3.5 h-3.5" />
            <span>{t("artifacts.goToSource")}</span>
          </button>
        )}
        {editable && (
          <button type="button" className={btn} onClick={() => setEditing(true)}>
            <Pencil className="w-3.5 h-3.5" />
            <span>{t("artifacts.edit")}</span>
          </button>
        )}
        {!editing && !confirming && modifiable && (
          <button type="button" className={btn} onClick={() => setConfirming(true)}>
            <Trash2 className="w-3.5 h-3.5" />
            <span>{t("artifacts.delete")}</span>
          </button>
        )}
        <button
          type="button"
          onClick={() => requestClose(onClose)}
          aria-label={t("common.close")}
          className="p-1 text-text-muted hover:text-text"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
      {confirming && (
        <div
          role="alertdialog"
          className="flex flex-wrap items-center gap-2 px-4 py-2 border-b border-border bg-danger/10 text-xs"
        >
          <span className="mr-auto text-text">{t("artifacts.deleteConfirm")}</span>
          <button
            type="button"
            disabled={deleting}
            onClick={() => void remove()}
            className="px-2.5 py-1 rounded-md bg-danger hover:bg-danger-hover text-white font-semibold disabled:opacity-50"
          >
            {t("artifacts.delete")}
          </button>
          <button
            type="button"
            disabled={deleting}
            onClick={() => setConfirming(false)}
            className={btn}
          >
            {t("artifacts.deleteCancel")}
          </button>
        </div>
      )}
      {!editing && detail?.provenance && (
        <ArtifactProvenance
          provenance={detail.provenance}
          onOpenCard={(taskId) => onOpenSource({ type: "kanban", taskId })}
        />
      )}
      {!editing && artifact.session_id && (
        <div className="px-4 py-2 border-b border-border">
          <SessionSourcesList key={artifactId} load={() => api.sources(artifactId)} />
        </div>
      )}
      {error && (
        <p className="px-4 py-2 text-xs text-danger border-b border-border break-words">
          {t("artifacts.error")} — {error}
        </p>
      )}
      {!modifiable && (
        <p className="px-4 py-2 text-xs text-text-secondary border-b border-border">
          {t("artifacts.readOnlyOtherChannel")}
        </p>
      )}
      {!editing && content?.truncated && (
        <p className="px-4 py-2 text-xs text-npc-dark border-b border-border flex flex-wrap gap-x-2">
          <span>{t("artifacts.truncated")}</span>
          {editableShape && <span>{t("artifacts.edit.truncatedReadOnly")}</span>}
        </p>
      )}
      {newerWhileEditing && (
        <p className="px-4 py-2 text-xs text-npc-dark border-b border-border">
          {t("artifacts.edit.newerVersion")}
        </p>
      )}
      {justSaved && (
        <p className="px-4 py-2 text-xs text-success border-b border-border">
          {t("artifacts.edit.saved")}
        </p>
      )}
      <div className="flex-1 min-h-0 overflow-auto p-4 text-xs">
        {editing && content && shape ? (
          <ArtifactEditor
            ref={editorRef}
            initial={content.text}
            filename={shape.filename}
            isLink={viewer === "link"}
            onSave={saveEdit}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <RenderBoundary
            key={`${artifactId}:${version}:${mode}`}
            fallback={
              <p className="text-text-secondary flex items-center gap-2">
                {t("artifacts.renderFailed")} {downloadLink}
              </p>
            }
          >
            {body}
          </RenderBoundary>
        )}
      </div>
    </div>
  );
}
