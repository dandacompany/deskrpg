"use client";
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";

import { useT } from "@/lib/i18n";

import { safeHttpUrl } from "./artifact-view-model";

/** Called before the screen wrapping the editor closes — if there are unsaved changes, confirm via an in-editor banner, then `proceed`. */
export type ArtifactEditorHandle = { requestClose(proceed: () => void): void };

export type ArtifactEditorProps = {
  ref?: Ref<ArtifactEditorHandle>;
  initial: string;
  filename: string;
  isLink: boolean;
  onSave(content: string, note: string): Promise<void>;
  onCancel(): void;
};

/** Only the subset of CodeMirror 6's actual `EditorView` shape that this component uses. */
type MinimalEditorView = {
  state: { doc: { toString(): string } };
  destroy(): void;
};

/**
 * Editor that edits an artifact's body and saves it as a new version. A link is a single-line
 * `<input type="url">`; everything else lazy-loads and attaches CodeMirror. Tracks whether it
 * changed (`dirty`) and, on cancel, confirms via an in-component banner rather than a modal.
 *
 * Tests get the real CodeMirror view via the `cmView` property attached to the
 * `data-testid="artifact-editor"` element and change the body with `view.dispatch(...)`
 * (this component treats the CodeMirror document as the source of truth instead of
 * mirroring its state into React).
 */
export default function ArtifactEditor({
  ref,
  initial,
  filename,
  isLink,
  onSave,
  onCancel,
}: ArtifactEditorProps) {
  const t = useT();
  const [linkValue, setLinkValue] = useState(initial);
  const [note, setNote] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<MinimalEditorView | null>(null);
  const contentRef = useRef(initial);
  /** What "confirm" on the confirmation banner does next (whichever was last requested — cancel or closing the modal). */
  const pendingRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (isLink) return;
    let alive = true;
    let view: MinimalEditorView | null = null;
    void (async () => {
      const [cm, langData, lang] = await Promise.all([
        import("codemirror"),
        import("@codemirror/language-data"),
        import("@codemirror/language"),
      ]);
      if (!alive || !hostRef.current) return;
      const { EditorView, basicSetup } = cm;
      const updateListener = EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        contentRef.current = update.state.doc.toString();
        setDirty(contentRef.current !== initial);
      });
      const extensions = [basicSetup, updateListener];
      const desc = lang.LanguageDescription.matchFilename(langData.languages, filename);
      if (desc) {
        try {
          extensions.push(await desc.load());
        } catch {
          // If language support fails to load, fall back to plain editing with no highlighting.
        }
      }
      if (!alive || !hostRef.current) return;
      const created = new EditorView({ doc: initial, extensions, parent: hostRef.current });
      view = created;
      viewRef.current = created;
      (hostRef.current as unknown as { cmView?: unknown }).cmView = created;
    })();
    return () => {
      alive = false;
      view?.destroy();
      viewRef.current = null;
    };
    // filename/initial don't change during an editing session — remount only on isLink.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLink]);

  const linkTrimmed = linkValue.trim();
  const validLink = isLink ? safeHttpUrl(linkValue) : null;
  const linkDirty = isLink && linkTrimmed !== initial.trim();
  const isDirty = isLink ? linkDirty : dirty;

  const save = async () => {
    setError(null);
    setSaving(true);
    try {
      const content = isLink ? `${validLink}\n` : contentRef.current;
      await onSave(content, note);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const requestClose = (proceed: () => void) => {
    if (isDirty) {
      pendingRef.current = proceed;
      setConfirmingCancel(true);
      return;
    }
    proceed();
  };
  useImperativeHandle(ref, () => ({ requestClose }));

  const confirmDiscard = () => {
    const proceed = pendingRef.current ?? onCancel;
    pendingRef.current = null;
    setConfirmingCancel(false);
    proceed();
  };

  return (
    <div className="flex flex-col gap-2 h-full min-h-0 text-xs">
      {isLink ? (
        <div className="flex flex-col gap-1">
          <input
            type="url"
            aria-label={filename}
            value={linkValue}
            onChange={(e) => setLinkValue(e.target.value)}
            className="px-2 py-1 rounded-md bg-surface-raised text-text font-mono"
          />
          <p className="text-[11px] text-text-dim">{t("artifacts.edit.linkHint")}</p>
        </div>
      ) : (
        <div
          ref={hostRef}
          data-testid="artifact-editor"
          className="flex-1 min-h-0 overflow-auto rounded-md border border-border [&_.cm-editor]:h-full"
        />
      )}
      <input
        type="text"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder={t("artifacts.edit.note")}
        aria-label={t("artifacts.edit.note")}
        className="px-2 py-1 rounded-md bg-surface-raised text-text"
      />
      {isDirty && <p className="text-[11px] text-npc-dark">{t("artifacts.edit.dirty")}</p>}
      {error && <p className="text-[11px] text-danger">{error}</p>}
      {confirmingCancel && (
        <div
          role="alertdialog"
          className="flex flex-wrap items-center gap-2 px-2 py-1.5 rounded-md bg-red-500/10"
        >
          <span className="mr-auto text-text">{t("common.unsavedChangesContinue")}</span>
          <button
            type="button"
            onClick={confirmDiscard}
            className="px-2.5 py-1 rounded-md bg-red-600 hover:bg-red-700 text-white font-semibold"
          >
            {t("common.confirm")}
          </button>
          <button
            type="button"
            onClick={() => {
              pendingRef.current = null;
              setConfirmingCancel(false);
            }}
            className="px-2.5 py-1 rounded-md bg-surface-raised text-text-secondary"
          >
            {t("common.back")}
          </button>
        </div>
      )}
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          disabled={saving}
          onClick={() => requestClose(onCancel)}
          className="px-2.5 py-1 rounded-md bg-surface-raised text-text-secondary disabled:opacity-50"
        >
          {t("artifacts.edit.cancel")}
        </button>
        <button
          type="button"
          disabled={saving || (isLink && !validLink)}
          onClick={() => void save()}
          className="px-2.5 py-1 rounded-md bg-primary text-white font-semibold disabled:opacity-50"
        >
          {t("artifacts.edit.save")}
        </button>
      </div>
    </div>
  );
}
