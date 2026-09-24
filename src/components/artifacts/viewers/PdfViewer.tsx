"use client";
import { useEffect, useRef, useState } from "react";

type Pdfjs = typeof import("pdfjs-dist");

/**
 * The seam for importing pdf.js. In production this is always the dynamic
 * `import("pdfjs-dist")`; only tests swap in a fake module (`heavy-viewers.test.tsx`).
 */
export const pdfjsLoader: { load(): Promise<Pdfjs> } = {
  load: () => import("pdfjs-dist"),
};

export default function PdfViewer({ blob }: { blob: Blob }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [doc, setDoc] = useState<import("pdfjs-dist").PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    // getDocument spins up a worker on every call — destroy the loading task on close to reclaim the document and worker together.
    let loadingTask: { destroy(): Promise<void> } | null = null;
    void (async () => {
      try {
        const pdfjs = await pdfjsLoader.load();
        pdfjs.GlobalWorkerOptions.workerSrc = new URL(
          "pdfjs-dist/build/pdf.worker.min.mjs",
          import.meta.url,
        ).toString();
        const data = new Uint8Array(await blob.arrayBuffer());
        if (!alive) return;
        const task = pdfjs.getDocument({ data });
        loadingTask = task;
        const loaded = await task.promise;
        if (alive) setDoc(loaded);
      } catch {
        if (alive) setFailed(true);
      }
    })();
    return () => {
      alive = false;
      void loadingTask?.destroy().catch(() => {});
    };
  }, [blob]);
  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    let task: { promise: Promise<void>; cancel(): void } | null = null;
    void (async () => {
      try {
        const p = await doc.getPage(page);
        const c = canvas.current;
        // Don't render if closed or if the page has since changed — pdf.js throws if render overlaps on the same canvas.
        if (cancelled || !c) return;
        const viewport = p.getViewport({ scale: 1.25 });
        c.width = viewport.width;
        c.height = viewport.height;
        task = p.render({ canvas: c, viewport });
        await task.promise;
      } catch (err) {
        // A render cut off by cleanup (cancel) is not a failure. Any other rejection goes to the error boundary.
        if ((err as { name?: string } | null)?.name === "RenderingCancelledException") return;
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, page]);
  if (failed) throw new Error("pdf_render_failed"); // ArtifactViewer's error boundary falls back to download
  return (
    <div className="flex h-full flex-col items-center gap-2 overflow-auto">
      <canvas ref={canvas} className="max-w-full shadow" />
      {doc && (
        <div className="flex items-center gap-2 text-xs">
          <button type="button" disabled={page <= 1} onClick={() => setPage((n) => n - 1)}>
            ‹
          </button>
          <span>
            {page} / {doc.numPages}
          </span>
          <button
            type="button"
            disabled={page >= doc.numPages}
            onClick={() => setPage((n) => n + 1)}
          >
            ›
          </button>
        </div>
      )}
    </div>
  );
}
