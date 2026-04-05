"use client";

import { useCallback, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import { Copy, Check } from "lucide-react";

// ─── Code block with copy button ────────────────────────────────────

function CodeBlock({ lang, children }: { lang: string; children: ReactNode }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    const text = typeof children === "string" ? children : extractText(children);
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [children]);

  return (
    <div className="my-1.5 rounded-md overflow-hidden relative group">
      <div className="flex items-center justify-between bg-surface px-2 py-0.5">
        <span className="text-text-dim text-[10px]">{lang || "code"}</span>
        <button
          onClick={handleCopy}
          className="text-text-dim hover:text-text transition-colors p-0.5"
          title="Copy"
        >
          {copied ? <Check className="w-3 h-3 text-success" /> : <Copy className="w-3 h-3" />}
        </button>
      </div>
      <pre className="bg-bg/80 px-2.5 py-2 overflow-x-auto text-xs leading-relaxed">
        <code>{children}</code>
      </pre>
    </div>
  );
}

function extractText(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (node && typeof node === "object" && "props" in node) {
    return extractText((node as { props: { children?: ReactNode } }).props.children);
  }
  return "";
}

// ─── Markdown components ────────────────────────────────────────────

const components: Components = {
  h1: ({ children }) => <h1 className="text-lg font-bold mt-3 mb-1">{children}</h1>,
  h2: ({ children }) => <h2 className="text-base font-bold mt-2.5 mb-1">{children}</h2>,
  h3: ({ children }) => <h3 className="text-sm font-bold mt-2 mb-0.5">{children}</h3>,
  h4: ({ children }) => <h4 className="text-sm font-semibold mt-1.5 mb-0.5">{children}</h4>,
  h5: ({ children }) => <h5 className="text-sm font-medium mt-1 mb-0.5">{children}</h5>,
  h6: ({ children }) => <h6 className="text-xs font-medium mt-1 mb-0.5 text-text-muted">{children}</h6>,
  p: ({ children }) => <p className="mb-1.5 last:mb-0 leading-relaxed">{children}</p>,
  strong: ({ children }) => <strong className="font-bold">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  del: ({ children }) => <del className="line-through opacity-60">{children}</del>,
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-text-dim pl-2 my-1.5 text-text-muted italic">
      {children}
    </blockquote>
  ),
  ul: ({ children }) => <ul className="list-disc pl-4 mb-1.5 space-y-0.5">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal pl-4 mb-1.5 space-y-0.5">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline hover:brightness-125">
      {children}
    </a>
  ),
  code: ({ className, children }) => {
    const isBlock = className?.startsWith("language-");
    if (isBlock) {
      const lang = className?.replace("language-", "") ?? "";
      return <CodeBlock lang={lang}>{children}</CodeBlock>;
    }
    return (
      <code className="bg-bg/60 px-1 py-0.5 rounded text-xs font-mono">{children}</code>
    );
  },
  pre: ({ children }) => <>{children}</>,
  hr: () => <hr className="border-border my-2" />,
  table: ({ children }) => (
    <div className="overflow-x-auto my-1.5">
      <table className="text-xs border-collapse w-full">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-surface">{children}</thead>,
  th: ({ children }) => <th className="border border-border px-2 py-1 text-left font-semibold">{children}</th>,
  td: ({ children }) => <td className="border border-border px-2 py-1">{children}</td>,
  img: ({ src, alt }) => (
    <img src={src} alt={alt || ""} className="max-w-full rounded my-1 max-h-60 object-contain" />
  ),
};

// ─── Export ─────────────────────────────────────────────────────────

export default function MarkdownContent({ content }: { content: string }) {
  return (
    <div className="markdown-chat">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
