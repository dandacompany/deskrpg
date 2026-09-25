import "../../../test-setup/dom";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { waitFor } from "@testing-library/react";

/**
 * `URL.createObjectURL` either doesn't exist in this runner environment (happy-dom) or doesn't
 * create a real blob URL, so we intercept the Blob constructor to synchronously pull out the
 * text of the last blob passed in. The browser's `Blob` doesn't expose its parts synchronously,
 * so here we remember the parts array we built ourselves and join it — the actual render output
 * (the string) doesn't change.
 */
let lastParts: unknown[] = [];
const OriginalBlob = globalThis.Blob;
class RecordingBlob extends OriginalBlob {
  constructor(parts: BlobPart[] = [], options?: BlobPropertyBag) {
    super(parts, options);
    lastParts = parts;
  }
}
globalThis.Blob = RecordingBlob as unknown as typeof Blob;

let objectUrlCounter = 0;
globalThis.URL.createObjectURL = (() =>
  `blob:mock-${(objectUrlCounter += 1)}`) as typeof URL.createObjectURL;
globalThis.URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;

function lastBlobText(): string {
  return lastParts.map((p) => (typeof p === "string" ? p : "")).join("");
}

let container: HTMLElement;
let root: Root | null = null;

async function render(ui: React.ReactElement) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(ui);
  });
}

test.afterEach(async () => {
  if (root) {
    const r = root;
    await act(async () => r.unmount());
    root = null;
  }
  container?.remove();
});

test("SvgViewer strips script/onload before rendering as a blob <img>", async () => {
  const { default: SvgViewer } = await import("./SvgViewer");
  await render(
    <SvgViewer
      text={
        '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script><rect width="1" height="1"/></svg>'
      }
    />,
  );
  const img = container.querySelector("img")!;
  assert.match(img.getAttribute("src")!, /^blob:/);
  assert.equal(lastBlobText().includes("script"), false);
  assert.equal(lastBlobText().includes("onload"), false);
});

test("CodeViewer renders HTML highlighted by shiki", async () => {
  const { default: CodeViewer } = await import("./CodeViewer");
  await render(<CodeViewer text={"const a = 1;"} language="ts" />);
  await waitFor(() => {
    if (!container.querySelector("pre.shiki")) throw new Error("shiki not rendered yet");
  });
});

test("ArtifactViewer doesn't statically import heavy viewer modules", () => {
  const src = readFileSync("src/components/artifacts/ArtifactViewer.tsx", "utf8");
  for (const mod of ["pdfjs-dist", "shiki", "dompurify"]) {
    assert.equal(src.includes(`from "${mod}"`), false, mod);
  }
  assert.match(src, /lazy\(\(\) => import\("\.\/viewers\/PdfViewer"\)\)/);
});

/* ---------- PdfViewer: swaps pdf.js for a fake module ---------- */

type FakeRenderTask = { promise: Promise<void>; cancel(): void };

/** A minimal module mimicking pdf.js. Records calls and lets the test decide each step's result. */
function fakePdfjs(opts: {
  load?: () => Promise<unknown>;
  getPage?: () => Promise<unknown>;
  render?: () => FakeRenderTask;
}) {
  const rec = {
    workerSrc: "",
    getDocumentData: null as Uint8Array | null,
    destroyed: 0,
    renders: 0,
  };
  const page = {
    getViewport: () => ({ width: 100, height: 50 }),
    render: () => {
      rec.renders += 1;
      return opts.render ? opts.render() : { promise: Promise.resolve(), cancel() {} };
    },
  };
  const doc = { numPages: 2, getPage: opts.getPage ?? (() => Promise.resolve(page)) };
  const mod = {
    GlobalWorkerOptions: {
      set workerSrc(v: string) {
        rec.workerSrc = v;
      },
      get workerSrc() {
        return rec.workerSrc;
      },
    },
    getDocument: (src: { data: Uint8Array }) => {
      rec.getDocumentData = src.data;
      return {
        promise: opts.load ? opts.load() : Promise.resolve(doc),
        destroy: () => {
          rec.destroyed += 1;
          return Promise.resolve();
        },
      };
    },
  };
  return { mod, rec, page };
}

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

/** A small boundary that catches errors thrown during render and displays them (same role as ArtifactViewer's RenderBoundary). */
async function withBoundary() {
  const { Component } = await import("react");
  return class Boundary extends Component<{ children: React.ReactNode }, { failed: boolean }> {
    state = { failed: false };
    static getDerivedStateFromError() {
      return { failed: true };
    }
    render() {
      return this.state.failed ? <p data-testid="fallback">failed</p> : this.props.children;
    }
  };
}

function cancelledTask(): FakeRenderTask & { cancelled: boolean } {
  let reject!: (e: unknown) => void;
  const task = {
    cancelled: false,
    promise: new Promise<void>((_, r) => {
      reject = r;
    }),
    cancel() {
      task.cancelled = true;
      const err = new Error("Rendering cancelled, page 1");
      err.name = "RenderingCancelledException";
      reject(err);
    },
  };
  return task;
}

test("PdfViewer sets workerSrc and calls getDocument with the blob's bytes, destroying the loading task on close", async () => {
  const viewerMod = await import("./PdfViewer");
  const { mod, rec } = fakePdfjs({});
  const restore = viewerMod.pdfjsLoader.load;
  viewerMod.pdfjsLoader.load = async () => mod as never;
  try {
    await render(<viewerMod.default blob={new OriginalBlob([new Uint8Array([37, 80, 68, 70])])} />);
    await settle();
    assert.match(rec.workerSrc, /pdf\.worker\.min\.mjs$/);
    assert.deepEqual(Array.from(rec.getDocumentData ?? []), [37, 80, 68, 70]);
    assert.equal(rec.renders, 1);
    assert.match(container.textContent ?? "", /1 \/ 2/);
    const r = root!;
    await act(async () => r.unmount());
    root = null;
    assert.equal(rec.destroyed, 1);
  } finally {
    viewerMod.pdfjsLoader.load = restore;
  }
});

test("PdfViewer: a render cancellation on close (RenderingCancelledException) doesn't leak as an unhandled rejection", async () => {
  const viewerMod = await import("./PdfViewer");
  const task = cancelledTask();
  const { mod } = fakePdfjs({ render: () => task });
  const restore = viewerMod.pdfjsLoader.load;
  viewerMod.pdfjsLoader.load = async () => mod as never;
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  try {
    await render(<viewerMod.default blob={new OriginalBlob([new Uint8Array([1])])} />);
    await settle();
    const r = root!;
    await act(async () => r.unmount());
    root = null;
    await new Promise((res) => setTimeout(res, 10));
    assert.equal(task.cancelled, true);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    viewerMod.pdfjsLoader.load = restore;
  }
});

test("PdfViewer: if getPage resolves after closing, render doesn't start", async () => {
  const viewerMod = await import("./PdfViewer");
  let resolvePage!: (p: unknown) => void;
  const pending = new Promise((r) => {
    resolvePage = r;
  });
  const { mod, rec, page } = fakePdfjs({ getPage: () => pending });
  const restore = viewerMod.pdfjsLoader.load;
  viewerMod.pdfjsLoader.load = async () => mod as never;
  try {
    await render(<viewerMod.default blob={new OriginalBlob([new Uint8Array([1])])} />);
    await settle();
    const r = root!;
    await act(async () => r.unmount());
    root = null;
    resolvePage(page);
    await new Promise((res) => setTimeout(res, 10));
    assert.equal(rec.renders, 0);
  } finally {
    viewerMod.pdfjsLoader.load = restore;
  }
});

test("PdfViewer: a failed page render throws, and the error boundary renders the fallback", async () => {
  const viewerMod = await import("./PdfViewer");
  const Boundary = await withBoundary();
  const { mod } = fakePdfjs({
    render: () => ({ promise: Promise.reject(new Error("bad page")), cancel() {} }),
  });
  const restore = viewerMod.pdfjsLoader.load;
  viewerMod.pdfjsLoader.load = async () => mod as never;
  try {
    await render(
      <Boundary>
        <viewerMod.default blob={new OriginalBlob([new Uint8Array([1])])} />
      </Boundary>,
    );
    await settle();
    assert.ok(container.querySelector('[data-testid="fallback"]'));
  } finally {
    viewerMod.pdfjsLoader.load = restore;
  }
});

test("PdfViewer: falls back to the fallback screen when getPage is rejected", async () => {
  const viewerMod = await import("./PdfViewer");
  const Boundary = await withBoundary();
  const { mod } = fakePdfjs({ getPage: () => Promise.reject(new Error("no page")) });
  const restore = viewerMod.pdfjsLoader.load;
  viewerMod.pdfjsLoader.load = async () => mod as never;
  try {
    await render(
      <Boundary>
        <viewerMod.default blob={new OriginalBlob([new Uint8Array([1])])} />
      </Boundary>,
    );
    await settle();
    assert.ok(container.querySelector('[data-testid="fallback"]'));
  } finally {
    viewerMod.pdfjsLoader.load = restore;
  }
});

test("ArtifactViewer: renders the renderFailed download fallback when getDocument is rejected", async () => {
  const viewerMod = await import("./PdfViewer");
  const { default: ArtifactViewer } = await import("../ArtifactViewer");
  const { I18nProvider } = await import("@/lib/i18n/context");
  const { default: ko } = await import("@/lib/i18n/locales/ko");
  const { mod, rec } = fakePdfjs({ load: () => Promise.reject(new Error("Invalid PDF")) });
  const restore = viewerMod.pdfjsLoader.load;
  viewerMod.pdfjsLoader.load = async () => mod as never;
  const artifact = {
    id: "p1",
    kind: "document",
    title: "보고서",
    profile: "sophie",
    source_kind: "chat",
    session_id: "s-1",
    current_version: 1,
    filename: "report.pdf",
    mime: "application/pdf",
    size: 4,
    sha256: "x",
    created_at: 1_790_000_000,
    updated_at: 1_790_000_000,
  };
  const api = {
    get: async () => ({
      artifact,
      versions: [
        {
          version: 1,
          filename: "report.pdf",
          mime: "application/pdf",
          size: 4,
          sha256: "x",
          created_by: "sophie",
          captured_via: "tool",
          created_at: 1_790_000_000,
        },
      ],
    }),
    fetchBlob: async () => new OriginalBlob([new Uint8Array([1, 2, 3])]),
    fetchText: async () => ({ text: "", truncated: false }),
    contentUrl: (id: string, v: number | null, dl?: boolean) =>
      `/c/${id}/${v}${dl ? "?download=1" : ""}`,
  };
  try {
    await render(
      <I18nProvider initialLocale="ko">
        <ArtifactViewer
          api={api as never}
          artifactId="p1"
          reloadKey={0}
          onOpenSource={() => {}}
          onDeleted={() => {}}
          onClose={() => {}}
        />
      </I18nProvider>,
    );
    await waitFor(() => {
      if (!(container.textContent ?? "").includes(ko["artifacts.renderFailed"]))
        throw new Error("fallback not rendered yet");
    });
    assert.deepEqual(Array.from(rec.getDocumentData ?? []), [1, 2, 3]);
    assert.ok(container.querySelector('a[download][href="/c/p1/1?download=1"]'));
  } finally {
    viewerMod.pdfjsLoader.load = restore;
  }
});

/* ---------- CodeViewer: cases that skip highlighting ---------- */

async function assertStaysPlain(text: string, language: string) {
  const { default: CodeViewer } = await import("./CodeViewer");
  await render(<CodeViewer text={text} language={language} />);
  await settle();
  await new Promise((res) => setTimeout(res, 50));
  await settle();
  const pre = container.querySelector("pre");
  assert.ok(pre, "plain <pre>");
  assert.equal(pre.classList.contains("shiki"), false);
  assert.ok(!container.querySelector("pre.shiki"));
}

test("CodeViewer: an unknown language stays as plain <pre>", async () => {
  await assertStaysPlain("hello", "definitely-not-a-language");
});

test("CodeViewer: language=text renders as plain <pre> without calling shiki", async () => {
  await assertStaysPlain("const a = 1;", "text");
});

test("CodeViewer: a body over 100,000 characters skips highlighting", async () => {
  await assertStaysPlain("const a = 1;\n".repeat(10_000), "ts");
});
